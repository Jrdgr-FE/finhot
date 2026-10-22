#!/usr/bin/env python3
"""Activate an inspected release, preserving current role environments and rollback copies."""
import grp,json,os,shlex,shutil,subprocess,sys
from pathlib import Path

if '--confirm-services' not in sys.argv:raise SystemExit('Requires approval of this release and service restart')
release=Path(sys.argv[1]).resolve()
if release.parent!=Path('/opt/finhot/releases') or not (release/'deploy/ecs/tune-summary-budget.ts').is_file():raise SystemExit('Invalid release')
previous=Path('/opt/finhot/current').resolve()
backup=Path('/etc/finhot/rollback-'+release.name)
if backup.exists():raise SystemExit('Activation already attempted; inspect rollback before retrying')
group=grp.getgrnam('finhot').gr_gid
def load(path):
    return {k:shlex.split(v)[0] if v else '' for k,v in (l.split('=',1) for l in Path(path).read_text().splitlines() if l and not l.startswith('#'))}
def run(args,**kwargs):
    result=subprocess.run(args,capture_output=True,text=True,**kwargs)
    if result.returncode:raise RuntimeError('Operation failed: '+args[0])
    return result.stdout
def save(path,values):
    path.write_text(''.join(f'{k}={json.dumps(v)}\n' for k,v in values.items()))
    os.chown(path,0,group);os.chmod(path,0o640)
roles={role:load('/etc/finhot/'+role+'.env') for role in ['api','web','worker','sync']}
if roles['worker'].get('ANALYZE_CONCURRENCY')!='1':raise SystemExit('Unexpected worker concurrency')
env={**os.environ,**roles['worker'],'PATH':'/opt/finhot/runtime/bin:/usr/bin:/bin','MODEL_CALLS_ENABLED':'false','COLLECT_ENABLED':'false'}
budgetArgs=['/usr/sbin/runuser','-u','finhot','--','/opt/finhot/runtime/bin/node','deploy/ecs/tune-summary-budget.ts']
before=json.loads(run(budgetArgs,cwd=release,env=env))
backup.mkdir(mode=0o700)
(backup/'release.txt').write_text(str(previous))
(backup/'budget.json').write_text(json.dumps(before))
for role in roles:
    copy=backup/(role+'.env');shutil.copyfile('/etc/finhot/'+role+'.env',copy);os.chmod(copy,0o600)
try:
    run(['systemctl','stop','finhot-worker'])
    budget=json.loads(run(budgetArgs+['--apply'],cwd=release,env=env))
    roles['worker'].update(FINHOT_BRIEF_FIRST='true',FINHOT_STORY_DIGEST_ENABLED='false')
    for role,values in roles.items():
        values['AIHOT_RELEASE']=release.name;save(Path('/etc/finhot/'+role+'.env'),values)
    nextLink=Path('/opt/finhot/current.next')
    if nextLink.exists() or nextLink.is_symlink():raise RuntimeError('An activation link already exists')
    nextLink.symlink_to(release);os.replace(nextLink,'/opt/finhot/current')
    run(['systemctl','restart','finhot-api','finhot-web'])
    run(['systemctl','start','finhot-worker'])
except Exception:
    # Preserve the budget cap and return services to the previous release on a failed activation.
    rollbackLink=Path('/opt/finhot/current.rollback')
    rollbackLink.symlink_to(previous);os.replace(rollbackLink,'/opt/finhot/current')
    for role in roles:save(Path('/etc/finhot/'+role+'.env'),load(backup/(role+'.env')))
    subprocess.run(['systemctl','restart','finhot-api','finhot-web','finhot-worker'],capture_output=True)
    raise SystemExit('Activation failed; previous release restored; inspect service status and saved budget')
print(json.dumps({'release':str(release),'rollback':str(backup),'budget':budget,'concurrency':1,'publicWebsiteDuringRestart':'Cloudflare serves last synchronized data'}))
