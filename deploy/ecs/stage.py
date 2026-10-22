#!/usr/bin/env python3
"""Stage a tested release and credentials without changing the active services or paid-call valves."""
import grp
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

release=Path(sys.argv[1]).resolve()
model_file=Path(sys.argv[2])
origin_file=Path(sys.argv[3])
if not str(release).startswith('/opt/finhot/releases/') or not (release/'node_modules').exists():
    raise SystemExit('Candidate dependencies are missing')
target=Path('/etc/finhot/candidate')
if target.exists() and ('--resume' not in sys.argv or f'AIHOT_RELEASE={json.dumps(release.name)}' not in (target/'api.env').read_text().splitlines()):raise SystemExit('Different candidate configuration exists; preserve it')
target.mkdir(mode=0o750,exist_ok=True)
group=grp.getgrnam('finhot').gr_gid
os.chown(target,0,group)
def read_env(file):
    out={}
    for line in Path(file).read_text().splitlines():
        if line and not line.startswith('#'):
            key,value=line.split('=',1)
            out[key]=shlex.split(value)[0] if value else ''
    return out
def write_env(name,values):
    file=target/(name+'.env')
    file.write_text(''.join(f'{key}={json.dumps(value)}\n' for key,value in values.items()))
    os.chown(file,0,group);os.chmod(file,0o640)
models=json.loads(model_file.read_text())
if set(models)-{'LLM_BASE_URL','LLM_MODEL','LLM_API_KEY','LLM_EXTRA_JSON','LLM_JSON_MODE','LLM_VISION','LLM_REASONING_HEADROOM'}:raise SystemExit('Unexpected model configuration')
if models.get('LLM_BASE_URL')!='https://api.commandcode.ai/provider/v1' or models.get('LLM_MODEL')!='deepseek/deepseek-v4.1-flash' or not models.get('LLM_API_KEY'):raise SystemExit('Model pricing does not match the configured provider')
origin=json.loads(origin_file.read_text())['FINHOT_ORIGIN_TOKEN']
if len(origin)<32:raise SystemExit('Origin token is too short')
api=read_env('/etc/finhot/api.env')
worker=read_env('/etc/finhot/worker.env')
web=read_env('/etc/finhot/web.env')
api.update(FINHOT_ORIGIN_TOKEN=origin,AIHOT_RELEASE=release.name,API_PORT='3101')
worker.update(models)
worker.update(EXTRACT_CONCURRENCY='1',AIHOT_RELEASE=release.name,MODEL_CALLS_ENABLED='false',COLLECT_ENABLED='false')
web.update(API_BASE_URL='http://127.0.0.1:3101',WEB_PORT='3100')
write_env('api',api);write_env('worker',worker);write_env('web',web)
env={**os.environ,**worker,'PATH':'/opt/finhot/runtime/bin:/usr/bin:/bin'}
subprocess.run(['/usr/sbin/runuser','-u','finhot','--','/opt/finhot/runtime/bin/node','scripts/migrate.ts'],cwd=release,env=env,check=True)
query="""
UPDATE budgets SET per_minute=0,per_hour=0,per_day=0 WHERE service<>'llm';
UPDATE budgets SET per_minute=6,per_hour=60,per_day=200,daily_cost_limit=1,cost_currency='USD',note='FinHot 每滚动24小时 USD 1.00；保守估算，含未知结果预留' WHERE service='llm';
INSERT INTO service_prices(service,model,currency,input_per_mtok,output_per_mtok,endpoint_url,source_url,verified_on,note)
VALUES('llm','deepseek/deepseek-v4.1-flash','USD',0.30,1.20,'https://api.commandcode.ai/provider/v1','https://commandcode.ai/docs/resources/pricing-limits',DATE '2026-10-03','最高时段价格；不扣缓存优惠；30天后需重新核验')
ON CONFLICT(service,model) DO UPDATE SET currency=EXCLUDED.currency,input_per_mtok=EXCLUDED.input_per_mtok,output_per_mtok=EXCLUDED.output_per_mtok,endpoint_url=EXCLUDED.endpoint_url,source_url=EXCLUDED.source_url,verified_on=EXCLUDED.verified_on,note=EXCLUDED.note;
"""
subprocess.run(['/usr/sbin/runuser','-u','finhot','--','/usr/bin/psql',worker['DATABASE_URL'],'-v','ON_ERROR_STOP=1'],input=query,text=True,stdout=subprocess.DEVNULL,check=True)
unit=f'''[Unit]
Description=FinHot candidate API (private acceptance)
After=postgresql.service
[Service]
User=finhot
Group=finhot
WorkingDirectory={release}
EnvironmentFile=/etc/finhot/candidate/api.env
ExecStart=/opt/finhot/runtime/bin/node --max-old-space-size=256 apps/api/src/main.ts
MemoryMax=384M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/finhot
UMask=0077
'''
Path('/etc/systemd/system/finhot-candidate-api.service').write_text(unit)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','start','finhot-candidate-api'],check=True)
print(json.dumps({'candidate':str(release),'api':'127.0.0.1:3101','dailyModelBudget':1,'currency':'USD','automaticModelCalls':False}))
