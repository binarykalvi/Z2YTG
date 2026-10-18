#!/usr/bin/env python3
import os
import sys
import requests
import time
from datetime import datetime, timedelta

ACCOUNT_ID    = os.environ.get("ZOOM_ACCOUNT_ID")
CLIENT_ID     = os.environ.get("ZOOM_CLIENT_ID")
CLIENT_SECRET = os.environ.get("ZOOM_CLIENT_SECRET")
GH_PAT        = os.environ.get("GH_PAT")
GH_REPO       = os.environ.get("GH_REPO")
DISPATCH_TYPE = "Z2YTG"
DEFAULT_DESCRIPTION = os.environ.get("DEFAULT_DESCRIPTION")
DEFAULT_VISIBILITY  = os.environ.get("DEFAULT_VISIBILITY")


def validate_env():
    missing = []
    for name, val in [
        ("ZOOM_ACCOUNT_ID", ACCOUNT_ID),
        ("ZOOM_CLIENT_ID", CLIENT_ID),
        ("ZOOM_CLIENT_SECRET", CLIENT_SECRET),
        ("GH_PAT", GH_PAT),
        ("GH_REPO", GH_REPO),
        ("DEFAULT_DESCRIPTION", DEFAULT_DESCRIPTION),
        ("DEFAULT_VISIBILITY", DEFAULT_VISIBILITY),
    ]:
        if not val:
            missing.append(name)

    if missing:
        sys.exit(1)


def get_zoom_token() -> str:
    r = requests.post(
        "https://zoom.us/oauth/token",
        params={"grant_type": "account_credentials", "account_id": ACCOUNT_ID},
        auth=(CLIENT_ID, CLIENT_SECRET),
    )
    if r.status_code != 200:
        sys.exit(1)
    return r.json()["access_token"]


def fetch_recordings(token: str):
    to_date   = datetime.now().strftime("%Y-%m-%d")
    from_date = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")

    r = requests.get(
        "https://api.zoom.us/v2/users/me/recordings",
        headers={"Authorization": f"Bearer {token}"},
        params={"from": from_date, "to": to_date, "page_size": 300},
    )
    if r.status_code != 200:
        sys.exit(1)
    return r.json().get("meetings", [])


def dispatch_to_github(zoom_url, meeting_name, record_date, meeting_uuid,
                       description, visibility) -> bool:
    url = f"https://api.github.com/repos/{GH_REPO}/dispatches"

    payload = {
        "event_type": DISPATCH_TYPE,
        "client_payload": {
            "zoom_url":     zoom_url,
            "meeting_name": meeting_name,
            "record_date":  record_date,
            "meeting_uuid": meeting_uuid,
            "description":  description,
            "visibility":   visibility,
        },
    }

    r = requests.post(
        url,
        headers={
            "Authorization": f"token {GH_PAT}",
            "Accept": "application/vnd.github+json",
        },
        json=payload,
    )

    return r.status_code == 204


def main():
    validate_env()

    token = get_zoom_token()

    meetings = fetch_recordings(token)

    if not meetings:
        return

    failed = 0

    for m in meetings:
        topic        = m.get("topic", "")
        start_time   = m.get("start_time", "")
        record_date  = start_time[:10] if start_time else datetime.now().strftime("%Y-%m-%d")
        meeting_uuid = m.get("uuid", "") or m.get("id", "")

        files = m.get("recording_files", [])
        if not files:
            continue

        zoom_url = m.get("share_url", "")
        if not zoom_url:
            continue

        password = m.get("password", "")
        if password and "pwd=" not in zoom_url:
            zoom_url = f"{zoom_url}?pwd={password}"

        ok = dispatch_to_github(
            zoom_url=zoom_url,
            meeting_name=topic,
            record_date=record_date,
            meeting_uuid=meeting_uuid,
            description=DEFAULT_DESCRIPTION,
            visibility=DEFAULT_VISIBILITY,
        )
        if not ok:
            failed += 1

        time.sleep(5)

    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
