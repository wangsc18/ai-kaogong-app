#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Mac 原生神经网络高精度中文 OCR 局域网桥接服务 (local_ocr_server.py)

零第三方 pip 依赖！直接通过 macOS 自带的 clang + Apple Vision.framework (VNRecognizeTextRequest)
提供 99%+ 准确率的公考中文/数字/表格离线毫秒级 OCR 识别服务。
当你在家或使用 Expo Go 真机测试，且想使用零成本离线超高精度识图时：

用法：
  python3 scripts/local_ocr_server.py
  然后在手机 App「设置 -> 备用免Key OCR 识题兜底引擎」填入终端打印的 http://<Mac局域网IP>:8765/ocr 即可！
"""

import base64
import json
import socket
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OBJC_OCR_SOURCE = r"""
#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <AppKit/AppKit.h>

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (argc < 2) return 1;
        NSString *path = [NSString stringWithUTF8String:argv[1]];
        NSImage *img = [[NSImage alloc] initWithContentsOfFile:path];
        if (!img) return 2;
        CGImageRef cgImg = [img CGImageForProposedRect:NULL context:nil hints:nil];
        if (!cgImg) return 3;

        VNRecognizeTextRequest *req = [[VNRecognizeTextRequest alloc] init];
        req.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        req.recognitionLanguages = @[@"zh-Hans", @"en-US"];
        req.usesLanguageCorrection = YES;

        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:cgImg options:@{}];
        NSError *err = nil;
        [handler performRequests:@[req] error:&err];
        if (err) {
            err = nil;
            req.usesCPUOnly = YES;
            [handler performRequests:@[req] error:&err];
        }
        if (err) {
            fprintf(stderr, "%s\n", [[err localizedDescription] UTF8String]);
            return 4;
        }

        for (VNRecognizedTextObservation *obs in req.results) {
            VNRecognizedText *top = [[obs topCandidates:1] firstObject];
            if (top) {
                printf("%s\n", [top.string UTF8String]);
            }
        }
    }
    return 0;
}
"""

BIN_PATH = Path("/tmp/kaogong_apple_vision_ocr_objc")


def ensure_vision_ocr_binary() -> Path:
    if BIN_PATH.exists():
        return BIN_PATH
    print("[Init] 正在首次编译 macOS Apple Vision 原生中文 OCR 组件（约需 2 秒）...")
    src_path = Path("/tmp/kaogong_ocr_helper.m")
    src_path.write_text(OBJC_OCR_SOURCE, encoding="utf-8")
    subprocess.run(
        [
            "clang",
            "-O2",
            "-fobjc-arc",
            "-framework",
            "Foundation",
            "-framework",
            "Vision",
            "-framework",
            "AppKit",
            str(src_path),
            "-o",
            str(BIN_PATH),
        ],
        check=True,
    )
    src_path.unlink(missing_ok=True)
    print(f"[Init] Apple Vision OCR 编译就绪 -> {BIN_PATH}")
    return BIN_PATH


def get_lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class OcrHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if not self.path.startswith("/ocr"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        payload = json.loads(raw.decode("utf-8"))
        b64 = payload.get("base64", "")
        img_bytes = base64.b64decode(b64)

        with tempfile.NamedTemporaryFile("wb", suffix=".jpg", delete=False, dir="/tmp") as tf:
            tf.write(img_bytes)
            tmp_img = tf.name

        try:
            proc = subprocess.run(
                [str(BIN_PATH), tmp_img],
                capture_output=True,
                text=True,
                check=True,
            )
            text = proc.stdout.strip()
            body = json.dumps({"ok": True, "text": text}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            err = json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(err)
        finally:
            Path(tmp_img).unlink(missing_ok=True)


if __name__ == "__main__":
    ensure_vision_ocr_binary()
    ip = get_lan_ip()
    port = 8765
    print(f"\n🚀 Apple Vision 中文高精度 OCR 服务已启动！")
    print(f"👉 手机 Expo Go 设置中填入地址: http://{ip}:{port}/ocr\n")
    ThreadingHTTPServer(("0.0.0.0", port), OcrHandler).serve_forever()
