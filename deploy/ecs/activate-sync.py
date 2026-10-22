#!/usr/bin/env python3
"""Run only after the operator approves the concrete release and service restart."""
import grp,json,os,shlex,subprocess,sys
from pathlib import Path
if '--confirm-services' not in sys.argv:raise SystemExit('Requires explicit operator approval of service restart')
release=Path(sys.argv[1]).resolve()
if not str(release).startswith('/opt/finhot/releases/') or not (release/'deploy/ecs/push-public.ts').exists():raise SystemExit('Invalid release')
group=grp.getgrnam('finhot').gr_gid
def load(path):
    return {k:shlex.split(v)[0] if v else '' for k,v in (l.split('=',1) for l in Path(path).read_text().splitlines() if l and not l.startswith('#'))}
def save(path,values):
    p=Path(path);p.write_text(''.join(f'{k}={json.dumps(v)}\n' for k,v in values.items()));os.chown(p,0,group);os.chmod(p,0o640)
previous=Path('/etc/finhot/rollback-'+release.name)
if previous.exists():raise SystemExit('Activation already staged; inspect before retrying')
previous.mkdir(mode=0o700)
previous.joinpath('release.txt').write_text(str(Path('/opt/finhot/current').resolve()))
for name in ['api','worker','web']:
    previous.joinpath(name+'.env').write_bytes(Path('/etc/finhot/'+name+'.env').read_bytes());os.chmod(previous/(name+'.env'),0o600)
worker=load('/etc/finhot/candidate/worker.env');worker.update(AIHOT_RELEASE=release.name,MODEL_CALLS_ENABLED='true',COLLECT_ENABLED='true',EXTRACT_CONCURRENCY='1')
api=load('/etc/finhot/candidate/api.env');api.update(AIHOT_RELEASE=release.name,API_PORT='3001')
sync=load('/etc/finhot/sync-preview/sync.env')
subprocess.run(['systemctl','stop','finhot-worker'],check=True)
save('/etc/finhot/worker.env',worker);save('/etc/finhot/api.env',api);save('/etc/finhot/sync.env',sync)
temp=Path('/opt/finhot/current.next');temp.symlink_to(release);os.replace(temp,'/opt/finhot/current')
for name in ['finhot-sync.service','finhot-sync.timer']:
    Path('/etc/systemd/system',name).write_text((release/'deploy/ecs'/name).read_text())
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','restart','finhot-api','finhot-web'],check=True)
subprocess.run(['systemctl','start','finhot-worker','finhot-sync.service'],check=True)
subprocess.run(['systemctl','enable','--now','finhot-sync.timer'],check=True)
subprocess.run(['systemctl','disable','--now','finhot-sync-preview.timer'],check=True)
print(json.dumps({'release':str(release),'modelDailyUsdLimit':1,'automaticModels':True,'syncSeconds':120,'domainRestoration':False,'rollback':str(previous)}))
