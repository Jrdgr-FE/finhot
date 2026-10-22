// Independent encrypted copy on the operator's Mac. Credentials never enter the shell command.
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,chmodSync,existsSync,mkdtempSync,rmSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
const instance='i-7xvi1a1vr6qpq5k2wh91',region='cn-guangzhou';
const option=(name)=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const sshHost=option('--ssh-host'),sshKey=option('--ssh-key'),sshKnownHosts=option('--ssh-known-hosts');
if(sshHost&&(!/^[A-Za-z0-9.-]+$/.test(sshHost)||!sshKey||!sshKnownHosts))throw new Error('SSH backup requires a host, private key and pinned known-hosts file');
if(sshHost&&(statSync(sshKey).mode&0o077)!==0)throw new Error('SSH private key must have owner-only permissions');
const sshOptions=sshHost?['-i',resolve(sshKey),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+resolve(sshKnownHosts),'-o','ConnectTimeout=20']:[];
const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z/,'Z');
const remote='/var/lib/finhot/backups/finhot-offsite-'+stamp+'.dump';
const destination=resolve(process.argv[2]||'.data/ops/backups');
mkdirSync(destination,{recursive:true,mode:0o700});chmodSync(destination,0o700);
function workbench(args){
  if(sshHost){
    const program=args[0]==='download'?'scp':'ssh';
    const command=args[0]==='download'?[...sshOptions,'root@'+sshHost+':'+args[1],args[2]]:[...sshOptions,'root@'+sshHost,args[args.indexOf('--command')+1]];
    const result=spawnSync(program,command,{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
    if(result.error||result.status!==0)throw new Error('SSH backup operation failed');
    return args[0]==='download'?{}:{stdout:result.stdout};
  }
  const result=spawnSync('workbench',[...args,'--instance-id',instance,'--region',region,'--output','json'],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
  if(result.error||result.status!==0)throw new Error('Workbench backup operation failed');
  if(args[0]==='download'&&!result.stdout.trim())return{};
  const parsed=JSON.parse(result.stdout);if(parsed.exit_code)throw new Error('Remote backup operation failed');return parsed;
}
const command=`python3 - <<'PY'
from pathlib import Path
import os,shlex,subprocess,json,hashlib
target=Path(${JSON.stringify(remote)})
if target.exists():raise SystemExit('Backup target already exists')
os.umask(0o077)
values={k:shlex.split(v)[0] if v else '' for k,v in (line.split('=',1) for line in Path('/etc/finhot/backup.env').read_text().splitlines() if line and not line.startswith('#'))}
r=subprocess.run(['/usr/sbin/runuser','-u','finhot','--','/usr/lib/postgresql/18/bin/pg_dump','--format=custom','--no-owner','--no-acl','--file='+str(target),values['DATABASE_URL']],capture_output=True)
if r.returncode:raise SystemExit('Database backup failed')
r=subprocess.run(['/usr/lib/postgresql/18/bin/pg_restore','--list',str(target)],capture_output=True)
if r.returncode:raise SystemExit('Database archive verification failed')
print(json.dumps({'remote':str(target),'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}))
PY`;
const result=workbench(['exec','--timeout','120','--command',command]);
const audit=JSON.parse(result.stdout||result.output);
const temp=mkdtempSync(join(tmpdir(),'finhot-backup-'));chmodSync(temp,0o700);
try{
  const file=join(temp,'database.dump');workbench(['download',remote,file]);chmodSync(file,0o600);
  const plain=readFileSync(file),sha=createHash('sha256').update(plain).digest('hex');
  if(sha!==audit.sha256)throw new Error('Downloaded backup checksum mismatch');
  if(spawnSync('pg_restore',['--list',file],{stdio:'ignore'}).status!==0)throw new Error('Local archive verification failed');
  const keyDir=join(homedir(),'.codex','finhot-backup');mkdirSync(keyDir,{recursive:true,mode:0o700});chmodSync(keyDir,0o700);
  const keyPath=join(keyDir,'encryption-key.bin');
  if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
  chmodSync(keyPath,0o600);const key=readFileSync(keyPath);if(key.length!==32)throw new Error('Invalid backup key');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([cipher.update(plain),cipher.final()]),tag=cipher.getAuthTag();
  const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);
  const restored=Buffer.concat([decipher.update(encrypted),decipher.final()]);
  if(createHash('sha256').update(restored).digest('hex')!==sha)throw new Error('Encrypted archive verification failed');
  const archive=join(destination,'finhot-'+stamp+'.dump.aes');
  writeFileSync(archive,Buffer.concat([Buffer.from('FINHOT01'),iv,tag,encrypted]),{mode:0o600,flag:'wx'});
  const metadata={...audit,...(sshHost?{sshHost}:{instance}),createdAt:new Date().toISOString(),archive,encryption:'AES-256-GCM',keyPath,independentCopy:true,automatic:false};
  writeFileSync(archive+'.json',JSON.stringify(metadata,null,2),{mode:0o600,flag:'wx'});
  if(process.argv.includes('--restore-test')){
    const database='finhot_offsite_'+stamp.toLowerCase()+'_test';
    for(const [program,args] of [['createdb',[database]],['pg_restore',['--exit-on-error','--no-owner','--no-acl','-d',database,file]]]){
      const r=spawnSync(program,args,{encoding:'utf8',timeout:180000,maxBuffer:1024*1024});if(r.status!==0)throw new Error('Independent test restore failed: '+r.stderr.slice(0,300));
    }
    const count=spawnSync('psql',['-d',database,'-At','-c',"SELECT json_build_object('articles',(SELECT count(*) FROM articles),'analyses',(SELECT count(*) FROM analyses))"],{encoding:'utf8'});
    if(count.status!==0)throw new Error('Restore count verification failed');
    metadata.restoreTest={database,...JSON.parse(count.stdout)};
    writeFileSync(archive+'.json',JSON.stringify(metadata,null,2),{mode:0o600});
  }
  console.log(JSON.stringify(metadata));
}finally{rmSync(temp,{recursive:true,force:true});}
