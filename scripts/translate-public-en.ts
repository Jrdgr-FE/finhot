import {translatePublicCopy} from '../packages/backend/src/editorial/public-copy-en.ts';
import {closeDb} from '../packages/backend/src/db.ts';
import {stopBoss} from '../packages/backend/src/jobs/queue.ts';
try{console.log(JSON.stringify(await translatePublicCopy({maxBatches:6})));}
finally{await stopBoss();await closeDb();}
