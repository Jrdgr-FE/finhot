import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";

const pdf = await getDocumentProxy(workerData as Uint8Array, { useSystemFonts:false,disableFontFace:true });
let text="",pages=0;
try {
  for(let n=1;n<=Math.min(10,pdf.numPages);n++) {
    const page=await pdf.getPage(n),content=await page.getTextContent();
    text+=content.items.map(i=>'str' in i?i.str+(i.hasEOL?'\n':' '):'').join('')+'\n';
    pages=n;page.cleanup();if(text.length>=60000)break;
  }
  parentPort!.postMessage({ text:text.replace(/\s+/g,' ').trim().slice(0,60000),scope:`PDF 前 ${pages} 页（共 ${pdf.numPages} 页），最多 60,000 字符` });
} finally { await pdf.loadingTask.destroy(); }
