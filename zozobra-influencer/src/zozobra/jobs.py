"""Tiny background job runner + scheduler for the control panel (replaces cron)."""
from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Callable

from .account_health import TZ

_pool = ThreadPoolExecutor(max_workers=2)
_lock = threading.Lock()
JOBS: dict[str, dict] = {}


def submit(title: str, fn: Callable, *args, **kwargs) -> str:
    job_id = uuid.uuid4().hex[:8]
    with _lock:
        JOBS[job_id] = {"id": job_id, "title": title, "status": "running", "result": "", "error": "",
                        "started": datetime.now(TZ).strftime("%d/%m %H:%M")}

    def run():
        print(f"[job] {title}: started", flush=True)
        try:
            result = fn(*args, **kwargs)
            JOBS[job_id].update(status="done", result=str(result)[:2000] if result is not None else "")
            print(f"[job] {title}: done {str(result)[:300]}", flush=True)
        except Exception as e:
            JOBS[job_id].update(status="failed", error=f"{type(e).__name__}: {e}",
                                result=traceback.format_exc()[-1500:])
            print(f"[job] {title}: FAILED\n{traceback.format_exc()}", flush=True)

    _pool.submit(run)
    return job_id


def recent(n: int = 12) -> list[dict]:
    return list(JOBS.values())[-n:][::-1]


class Scheduler(threading.Thread):
    """publish-due every 15 min, metrics nightly 02:30, auto weekly plan Sunday 10:00 (if enabled)."""

    daemon = True

    def __init__(self, publish: Callable, metrics: Callable, weekly_plan: Callable):
        super().__init__(name="lilo-scheduler")
        self.publish, self.metrics, self.weekly_plan = publish, metrics, weekly_plan
        self.stop = threading.Event()
        self.last: dict[str, str] = {}

    def _once(self, key: str, stamp: str, title: str, fn: Callable) -> None:
        if self.last.get(key) != stamp:
            self.last[key] = stamp
            submit(title, fn)

    def run(self) -> None:
        while not self.stop.wait(30):
            now = datetime.now(TZ)
            self._once("publish", now.strftime("%Y%m%d%H") + str(now.minute // 15), "פרסום מתוזמן", self.publish)
            if now.hour == 2 and now.minute >= 30:
                self._once("metrics", now.strftime("%Y%m%d"), "איסוף נתונים לילי", self.metrics)
            if now.weekday() == 6 and now.hour == 10:
                self._once("plan", now.strftime("%Y%m%d"), "תוכנית שבועית אוטומטית", self.weekly_plan)
