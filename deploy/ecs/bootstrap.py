#!/usr/bin/env python3
"""Configure a fresh ECS deployment; never print credentials or enable paid calls."""
import grp
import json
import os
from pathlib import Path
import pwd
import secrets
import subprocess
import sys

release = Path(sys.argv[1]).resolve()
admin_file = Path(sys.argv[2])
if not (release / "apps/web/build/server/index.js").is_file():
    raise SystemExit("Built frontend is missing")
if Path("/etc/finhot/api.env").exists():
    raise SystemExit("Existing FinHot environment found; preserve it and use the update procedure")
if not str(release).startswith("/opt/finhot/releases/"):
    raise SystemExit("Release must be under /opt/finhot/releases/")
try:
    account = pwd.getpwnam("finhot")
except KeyError:
    subprocess.run(["useradd", "--system", "--home-dir", "/var/lib/finhot", "--shell", "/usr/sbin/nologin", "finhot"], check=True)
    account = pwd.getpwnam("finhot")
group = grp.getgrnam("finhot")
for folder in ["/var/lib/finhot", "/var/lib/finhot/backups", "/etc/finhot"]:
    p = Path(folder)
    p.mkdir(parents=True, exist_ok=True)
    os.chown(p, account.pw_uid if folder.startswith("/var/lib") else 0, group.gr_gid)
    os.chmod(p, 0o750)
admin = admin_file.read_text().strip()
if len(admin) < 12 or "\n" in admin or "\r" in admin or '"' in admin:
    raise SystemExit("Unsupported administrator password format")
password = secrets.token_hex(32)
session = secrets.token_hex(32)
image = secrets.token_hex(32)
db_url = f"postgres://finhot:{password}@127.0.0.1:5432/finhot"
sql = f"CREATE ROLE finhot LOGIN PASSWORD '{password}';\nCREATE DATABASE finhot OWNER finhot;\n"
subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-v", "ON_ERROR_STOP=1"], input=sql, text=True, check=True, stdout=subprocess.DEVNULL)
common = {
    "NODE_ENV": "production", "PATH": "/opt/finhot/runtime/bin:/usr/bin:/bin",
    "SITE_URL": "https://finhot.fun", "AIHOT_ENVIRONMENT": "ecs-staging",
    "AIHOT_DATA_DIR": "/var/lib/finhot", "DATABASE_POOL_MAX": "3",
    "MODEL_CALLS_ENABLED": "false", "COLLECT_ENABLED": "false",
    "JINA_BODY_FALLBACK": "false", "FEISHU_CONTENT_PUSH_ENABLED": "false",
    "FEISHU_INTERNAL_ENABLED": "false", "INDEXNOW_SUBMIT_ENABLED": "false",
    "FETCH_CONCURRENCY": "2", "ANALYZE_CONCURRENCY": "1", "EXTRACT_CONCURRENCY": "1",
    "API_BASE_URL": "http://127.0.0.1:3001", "LOCAL_ROUTER_URL": "http://127.0.0.1:3000",
}
api = {**common, "DATABASE_URL": db_url, "API_HOST": "127.0.0.1", "API_PORT": "3001", "TRUST_PROXY": "true", "ADMIN_PASSWORD": admin, "SESSION_SECRET": session, "IMG_PROXY_SIGN_SECRET": image}
worker = {**common, "DATABASE_URL": db_url, "IMG_PROXY_SIGN_SECRET": image}
web = {"NODE_ENV": "production", "PATH": common["PATH"], "WEB_HOST": "127.0.0.1", "WEB_PORT": "3000", "SITE_URL": common["SITE_URL"], "API_BASE_URL": common["API_BASE_URL"], "TRUST_PROXY": "true"}
for name, values in {"api": api, "worker": worker, "web": web, "backup": {"DATABASE_URL": db_url}}.items():
    p = Path(f"/etc/finhot/{name}.env")
    p.write_text("".join(f"{key}={json.dumps(value)}\n" for key, value in values.items()))
    os.chown(p, 0, group.gr_gid)
    os.chmod(p, 0o640)
current = Path("/opt/finhot/current")
if current.exists() or current.is_symlink():
    raise SystemExit("Existing current release found; preserve it")
current.symlink_to(release, target_is_directory=True)
print(json.dumps({"configured": True, "release": str(release), "modelCalls": False, "collection": False}))
