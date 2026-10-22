// Decrypt a backup into a private temporary directory and restore only into an empty test database.
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createDecipheriv} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const [archive,database]=process.argv.slice(2);
if(!archive||!database||!/^[a-z][a-z0-9_]{0,55}_(test|ci)$/.test(database))throw new Error('Usage: node restore-backup.mjs archive.dump.aes empty_database_test');
const run=(program,args)=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});if(r.status!==0)throw new Error('Restore verification failed at '+program);return r.stdout;};
const n=run('psql',['-d',database,'-At','-c',"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"]);
if(Number(n)!==0)throw new Error('Restore target must be an empty test database');
const file=readFileSync(archive);if(file.length<36||file.subarray(0,8).toString()!=='FINHOT01')throw new Error('Unknown backup format');
const key=readFileSync(join(homedir(),'.codex','finhot-backup','encryption-key.bin'));
const cipher=createDecipheriv('aes-256-gcm',key,file.subarray(8,20));cipher.setAuthTag(file.subarray(20,36));
const plain=Buffer.concat([cipher.update(file.subarray(36)),cipher.final()]);
const temp=mkdtempSync(join(tmpdir(),'finhot-restore-'));
try{
  const dump=join(temp,'database.dump');writeFileSync(dump,plain,{mode:0o600});
  run('pg_restore',['--exit-on-error','--no-owner','--no-acl','-d',database,dump]);
  const counts=JSON.parse(run('psql',['-d',database,'-At','-c',"SELECT json_build_object('articles',(SELECT count(*) FROM articles),'analyses',(SELECT count(*) FROM analyses))"]));
  console.log(JSON.stringify({database,decryptedArchiveRestored:true,...counts}));
}finally{rmSync(temp,{recursive:true,force:true});}
