#!/usr/bin/env python3
"""Recover a built-in image_gen PNG from a Codex rollout JSONL file."""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rollout", required=True, type=Path)
    parser.add_argument("--call-id", required=True)
    parser.add_argument("--out", required=True, type=Path)
    return parser.parse_args()


def recover(rollout_path: Path, call_id: str, out_path: Path) -> int:
    for line_number, line in enumerate(rollout_path.read_text(encoding="utf-8").splitlines(), start=1):
        if "image_generation_end" not in line:
            continue
        message = json.loads(line)
        payload = message.get("payload", {})
        if payload.get("type") != "image_generation_end" or payload.get("call_id") != call_id:
            continue

        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(base64.b64decode(payload["result"]))
        return line_number

    raise ValueError(f"call id {call_id!r} not found in image_generation_end records: {rollout_path}")


def main() -> None:
    args = parse_args()
    line_number = recover(args.rollout, args.call_id, args.out)
    print(f"recovered call_id={args.call_id} line={line_number} out={args.out}")


if __name__ == "__main__":
    main()
