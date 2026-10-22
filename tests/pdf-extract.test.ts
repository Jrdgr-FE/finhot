import './setup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractPdfFragment } from '@aihot/backend/content/pdf';
import { buildScoreInput } from '@aihot/backend/editorial/analyze';
import { renderContext } from '@aihot/backend/editorial/writing';

test('PDF parser runs in a bounded worker, reads at most ten pages and reports the actual scope',async()=>{
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids ['+Array.from({length:12},(_,i)=>`${3+i*2} 0 R`).join(' ')+'] /Count 12 >>'];
  for(let i=1;i<=12;i++){const text=`BT /F1 12 Tf 20 100 Td (Page ${i}) Tj ET`;objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 27 0 R >> >> /Contents ${4+(i-1)*2} 0 R >>`,`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);}
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const at=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Root 1 0 R /Size ${objects.length+1} >>\nstartxref\n${at}\n%%EOF`;
  const result=await extractPdfFragment(new TextEncoder().encode(pdf));assert.ok(result.text.includes('Page 10'));assert.ok(!result.text.includes('Page 11'));assert.match(result.scope,/前 10 页（共 12 页）/);
  await assert.rejects(extractPdfFragment(new Uint8Array(6*1024*1024+1)),/6 MB/);
});
test('PDF fragments cannot be described to scoring or writing as the complete report',()=>{
  const a={id:'pdf-test',revision:1,title:'报告',url:'https://example.org/report.pdf',author:null,publishedAt:null,bodyText:'片段',excerpt:null,bodyStatus:'ok',materialScope:'PDF 前 3 页（共 100 页）',xPost:null,media:[],source:{name:'Source',kind:'json_list',tier:'T1',firstParty:true}};
  assert.ok(!buildScoreInput(a).includes('【完整正文】'));assert.match(buildScoreInput(a),/前 3 页/);assert.match(renderContext(a),/不代表完整报告/);
});
