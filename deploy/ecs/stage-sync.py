#!/usr/bin/env python3
"""Create a new private sync service. Does not switch/restart the existing application."""
import grp,json,os,shlex,subprocess,sys
from pathlib import Path
release=Path(sys.argv[1]).resolve()
if not str(release).startswith('/opt/finhot/releases/') or not (release/'node_modules').exists():raise SystemExit('Release missing')
settings=json.loads(Path(sys.argv[2]).read_text())
if set(settings)!={'FINHOT_SYNC_URL','FINHOT_SYNC_TOKEN'} or len(settings['FINHOT_SYNC_TOKEN'])<32:raise SystemExit('Invalid sync credential')
target=Path('/etc/finhot/sync-preview')
if target.exists():raise SystemExit('Existing preview configuration; preserve it')
target.mkdir(mode=0o750);group=grp.getgrnam('finhot').gr_gid;os.chown(target,0,group)
def read_env(path):
    return {k:shlex.split(v)[0] if v else '' for k,v in (l.split('=',1) for l in Path(path).read_text().splitlines() if l and not l.startswith('#'))}
env=read_env('/etc/finhot/candidate/worker.env')
sync={k:env[k] for k in ['DATABASE_URL','AIHOT_CREDENTIALS_DIR'] if k in env}
sync.update(settings,MODEL_CALLS_ENABLED='false',COLLECT_ENABLED='false',DATABASE_POOL_MAX='2',FINHOT_SYNC_STATE='/var/lib/finhot/sync-preview-state.json')
file=target/'sync.env';file.write_text(''.join(f'{k}={json.dumps(v)}\n' for k,v in sync.items()));os.chown(file,0,group);os.chmod(file,0o640)
command=['/usr/sbin/runuser','-u','finhot','--','/opt/finhot/runtime/bin/node','--max-old-space-size=192']
runtime={**os.environ,**sync,'PATH':'/opt/finhot/runtime/bin:/usr/bin:/bin'}
subprocess.run(command+['scripts/migrate.ts'],cwd=release,env=runtime,check=True)
subprocess.run(command+['deploy/ecs/import-cloudflare.ts',sys.argv[3]],cwd=release,env=runtime,check=True)
if len(sys.argv)>4:subprocess.run(command+['deploy/ecs/import-reports.ts',sys.argv[4]],cwd=release,env=runtime,check=True)
unit=(release/'deploy/ecs/finhot-sync.service').read_text().replace('WorkingDirectory=/opt/finhot/current',f'WorkingDirectory={release}').replace('/etc/finhot/sync.env',str(file))
(Path('/etc/systemd/system')/'finhot-sync-preview.service').write_text(unit)
timer=(release/'deploy/ecs/finhot-sync.timer').read_text().replace('finhot-sync.service','finhot-sync-preview.service')
(Path('/etc/systemd/system')/'finhot-sync-preview.timer').write_text(timer)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','start','finhot-sync-preview.service'],check=True)
subprocess.run(['systemctl','enable','--now','finhot-sync-preview.timer'],check=True)
print(json.dumps({'syncTarget':settings['FINHOT_SYNC_URL'],'release':str(release),'intervalSeconds':120,'automaticModels':False,'publicEcsPorts':False}))
