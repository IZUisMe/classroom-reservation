import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
const path = process.argv[2] || 'public/templates/application.pdf';
const bytes = await readFile(path);
if (bytes.subarray(0,5).toString() !== '%PDF-') throw Error('Invalid PDF signature');
const pdf = await PDFDocument.load(bytes, {updateMetadata:false});
console.log('pages',pdf.getPageCount(),'size',pdf.getPages().map(p=>p.getSize()));
console.log('metadata',{title:pdf.getTitle(),author:pdf.getAuthor(),creator:pdf.getCreator(),producer:pdf.getProducer()});
const p=pdf.getPage(0);const contents=p.node.Contents();
const refs=contents instanceof PDFArray?contents.asArray():[contents];
let s='';for(const ref of refs){const stream=pdf.context.lookup(ref);if(stream instanceof PDFRawStream)s+=Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');}
await writeFile('tools/template-content.txt',s);
console.log('stream characters',s.length);
