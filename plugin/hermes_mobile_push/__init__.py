"""Hands Hermes lifecycle events to the Hermes Mobile server on this host.

The server decides what reaches the phone (server/push.mjs); this plugin only reports what happened:
a turn started, replied or ended, Hermes is waiting on a person (an approval, a clarify question, a
sudo password) or stopped waiting, and a delegated task started or finished.

Events go over a unix socket in the server's private directory, so only this account can send them.
Delivery runs on one daemon thread behind a bounded queue: a hook returns at once, never raises, and
a server that is down or slow costs nothing but the dropped event.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import socket
import threading
from typing import Any

logger = logging.getLogger(__name__)

VERSION = 1
MAX_TEXT = 4000
TIMEOUT_S = 3.0
_queue: "queue.Queue[bytes]" = queue.Queue(maxsize=256)
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()
_profile = "default"


def socket_path() -> str:
    explicit = os.environ.get("HERMES_MOBILE_EVENTS", "").strip()

    if explicit:
        return explicit

    runtime = os.environ.get("XDG_RUNTIME_DIR", "").strip() or f"/run/user/{os.getuid()}"

    return os.path.join(runtime, "hermes-mobile", "events.sock")


def register(ctx: Any) -> None:
    global _profile
    try:
        _profile = str(ctx.profile_name or "default")
    except Exception:  # noqa: BLE001 - an older Hermes without the property
        _profile = "default"
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("post_llm_call", _post_llm_call)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_hook("on_human_input_request", _on_human_input_request)
    ctx.register_hook("on_human_input_resolved", _on_human_input_resolved)
    ctx.register_hook("subagent_start", _subagent_start)
    ctx.register_hook("subagent_stop", _subagent_stop)


def _pre_llm_call(**kwargs: Any) -> None:
    _send("turn_start", kwargs, ("session_id", "turn_id", "platform", "parent_session_id"))


def _post_llm_call(**kwargs: Any) -> None:
    event = _fields(kwargs, ("session_id", "turn_id", "platform", "task_id"))
    response = kwargs.get("assistant_response")
    event["text"] = response[:MAX_TEXT] if isinstance(response, str) else ""
    _emit("reply", event)


def _on_session_end(**kwargs: Any) -> None:
    event = _fields(kwargs, ("session_id", "turn_id", "platform", "task_id"))

    # Only what Hermes said: a session closing (no turn) carries none of these.
    for flag in ("completed", "failed", "interrupted"):
        if isinstance(kwargs.get(flag), bool):
            event[flag] = kwargs[flag]

    _emit("turn_end", event)


def _on_human_input_request(**kwargs: Any) -> None:
    event = _fields(kwargs, ("kind", "request_id", "session_id", "session_key", "platform"))
    # Hermes redacts the prompt before any plugin sees it; what a person types back is never here.
    prompt = kwargs.get("prompt")
    event["prompt"] = prompt[:MAX_TEXT] if isinstance(prompt, str) else ""
    _emit("input", event)


def _on_human_input_resolved(**kwargs: Any) -> None:
    _send("input_resolved", kwargs, ("kind", "request_id", "session_id", "outcome"))


def _subagent_start(**kwargs: Any) -> None:
    _send("subagent_start", kwargs, ("parent_session_id", "parent_turn_id", "child_session_id"))


def _subagent_stop(**kwargs: Any) -> None:
    event = _fields(kwargs, ("parent_session_id", "parent_turn_id", "child_session_id", "child_status"))
    summary = kwargs.get("child_summary")
    event["summary"] = summary[:MAX_TEXT] if isinstance(summary, str) else ""
    _emit("task_end", event)


def _fields(kwargs: dict[str, Any], names: tuple[str, ...]) -> dict[str, Any]:
    return {name: kwargs[name] for name in names if isinstance(kwargs.get(name), str) and kwargs[name]}


def _send(name: str, kwargs: dict[str, Any], names: tuple[str, ...]) -> None:
    _emit(name, _fields(kwargs, names))


def _emit(name: str, event: dict[str, Any]) -> None:
    try:
        from hermes_constants import get_hermes_home

        home = str(get_hermes_home())
    except Exception:  # noqa: BLE001 - outside Hermes (tests)
        home = os.environ.get("HERMES_HOME", "")

    event.update({"v": VERSION, "event": name, "home": home, "profile": _profile, "pid": os.getpid()})

    try:
        _queue.put_nowait(json.dumps(event).encode("utf-8"))
    except queue.Full:
        return
    except Exception:  # noqa: BLE001 - a hook must never break the turn
        logger.debug("hermes_mobile_push: event not queued", exc_info=True)
        return

    _ensure_worker()


def _ensure_worker() -> None:
    global _worker
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_deliver_forever, name="hermes-mobile-push", daemon=True)
            _worker.start()


def _deliver_forever() -> None:
    while True:
        body = _queue.get()
        try:
            _post(body)
        except Exception:  # noqa: BLE001 - the server may be stopped or restarting
            logger.debug("hermes_mobile_push: event not delivered", exc_info=True)


def _post(body: bytes) -> None:
    path = socket_path()

    if not os.path.exists(path):
        return

    request = (
        b"POST /event HTTP/1.1\r\nHost: hermes-mobile\r\nContent-Type: application/json\r\n"
        + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode("ascii")
        + body
    )

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(TIMEOUT_S)
        conn.connect(path)
        conn.sendall(request)
        conn.recv(64)
