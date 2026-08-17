# -*- coding: utf-8 -*-
"""
ra-synth-daemon.py — dsh-read-aloud 常驻 edge-tts 合成服务。

协议（stdio，JSON Lines）：
  输入: {"id": 1, "text": "...", "voice": "zh-CN-XiaoxiaoNeural", "rate": "+0%", "out": "C:/.../file.mp3"}
  输出: {"id": 1, "ok": true} 或 {"id": 1, "ok": false, "err": "..."}

设计：
- 一次进程生命周期内复用 edge_tts 包（import 开销只付一次），
  每次请求只承担网络合成时间（~2.5s），无 python 启动（~0.5-1s）。
- 串行处理（单任务）：调用方（speaker）已用串行链保证同一时刻一个合成任务。
- 失败不退出：继续读下一条（网络抖动时 speaker 侧会走降级链）。
"""
import asyncio
import json
import sys

# Windows 下 stdin/stdout 默认按 locale（GBK）解码/编码，node 端以 UTF-8 写入——
# 强制 UTF-8，避免中文文本 surrogate 乱码（'utf-8' codec can't encode '\udc82'）。
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8")

import edge_tts

POOL = edge_tts.Communicate  # 仅确保 import 生效


def make_communicate(text, voice, rate):
    kwargs = {}
    if rate and rate != "+0%":
        kwargs["rate"] = rate
    return edge_tts.Communicate(text, voice, **kwargs)


async def handle(req):
    com = make_communicate(req.get("text", ""), req.get("voice", "zh-CN-XiaoxiaoNeural"), req.get("rate", "+0%"))
    await com.save(req.get("out", ""))


def main():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"id": None, "ok": False, "err": "bad json: %s" % e}), flush=True)
            continue
        try:
            loop.run_until_complete(handle(req))
            print(json.dumps({"id": req.get("id"), "ok": True}), flush=True)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"id": req.get("id"), "ok": False, "err": str(e)}), flush=True)
    loop.close()


if __name__ == "__main__":
    main()
