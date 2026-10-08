import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const photoRoot = path.resolve(process.env.PHOTO_ROOT || root);
const phoneMode = Boolean(process.env.PHOTO_ROOT);
const sortedRoot = path.join(root, 'Sorted');
const preferredFoldersFile = path.join(os.homedir(), '.config', 'pics', 'preferred-folders.json');
const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif']);
const datePhotoExtensions = new Set(['.jpg','.jpeg','.jpe','.jfif','.png','.webp','.gif','.bmp','.tif','.tiff','.avif','.heic','.heif','.dng','.cr2','.cr3','.nef','.arw','.raf','.rw2','.orf','.pef','.srw','.3fr','.ari','.bay','.cap','.cin','.dcs','.dcr','.drf','.eip','.iiq','.k25','.kdc','.mdc','.mef','.mos','.mrw','.nrw','.obm','.ptx','.pxn','.r3d','.rwz','.sr2','.srf','.sti','.x3f','.raw','.mpo']);
const mime = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif',
  '.heic': 'image/heic', '.heif': 'image/heif'
};
const defaultFolders = ['Keep', 'Family', 'Friends', 'Trips', 'Pets', 'Screenshots', 'Documents', 'Later'];
let folders = defaultFolders;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/page4.html', ['v98/page4.html', 'text/html; charset=utf-8']],
  ['/page4-capture.html', ['v98/page4.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/date-batches', ['v98/page4.html', 'text/html; charset=utf-8']],
  ['/date-batches/', ['v98/page4.html', 'text/html; charset=utf-8']]
]);
let photos = new Map();
let pictureFolders = [];
let selectedDirectory = null;
let destinationFolders = new Map();

async function createDestinationFolder(name) {
  const clean = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ');
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid folder name');
  if (clean.length > 80) throw new Error('Folder name is too long');
  const picturesRoot = path.join(photoRoot, 'Pictures');
  await fs.mkdir(picturesRoot, { recursive: true });
  const directory = path.join(picturesRoot, clean);
  if (path.dirname(directory) !== picturesRoot) throw new Error('Invalid folder name');
  try { await fs.mkdir(directory); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Folder name is not available');
  const relative = path.relative(photoRoot, directory);
  return { id: Buffer.from(relative).toString('base64url'), name: clean, location: relative };
}

async function createFolderIn(parentId, name) {
  const clean = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ');
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid folder name');
  if (clean.length > 80) throw new Error('Folder name is too long');
  const parent = await resolveFolder(parentId);
  const directory = path.join(parent.directory, clean);
  if (path.dirname(directory) !== parent.directory) throw new Error('Invalid folder name');
  try { await fs.mkdir(directory); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('A folder with that name already exists');
    throw error;
  }
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Folder name is not available');
  const relative = path.relative(photoRoot, directory);
  return { id: Buffer.from(relative).toString('base64url'), name: clean, location: relative };
}

async function scanDestinationFolders() {
  const picturesRoot = path.join(photoRoot, 'Pictures');
  let entries;
  try { entries = await fs.readdir(picturesRoot, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    if (['EACCES','EPERM'].includes(error.code)) throw new Error('Termux cannot read the Pictures folder');
    throw error;
  }
  return entries.filter(e => e.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true})).map(e => {
    const relative = path.relative(photoRoot, path.join(picturesRoot,e.name));
    return { id: Buffer.from(relative).toString('base64url'), name:e.name, location:relative };
  });
}

async function scanPictureFolders(onProgress) {
  const results = [], pending = [photoRoot];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    visited++;
    if (onProgress && visited % 10 === 0) onProgress({ type: 'folder-progress', visited });
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (['EACCES','EPERM','ENOENT'].includes(error.code)) continue;
      throw error;
    }
    let imageCount = 0;
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (file !== photoRoot && !insidePhotoRoot(file)) continue;
      if (entry.isDirectory()) {
        if (!['.git','node_modules'].includes(entry.name)) pending.push(file);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) imageCount++;
    }
    if (imageCount) {
      const relative = path.relative(photoRoot, directory) || '.';
      results.push({ id: Buffer.from(relative).toString('base64url'), name: path.basename(directory) || path.basename(photoRoot), location: relative, imageCount });
    }
  }
  results.sort((a,b)=>a.location.localeCompare(b.location,undefined,{numeric:true}));
  pictureFolders = results;
  return results;
}


function readCaptureDate(bytes) {
  const ascii=(start,length)=>{let value='';for(let i=0;i<length&&start+i<bytes.length;i++)value+=String.fromCharCode(bytes[start+i]);return value};
  const parse=value=>{const m=value.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);if(!m)return null;const d=new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]);return Number.isNaN(d.getTime())?null:m[1]+'-'+m[2]+'-'+m[3]};
  const tiff=(start,length)=>{const end=Math.min(bytes.length,start+length);if(start<0||start+8>end)return null;const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),order=ascii(start,2),little=order==='II';if(!little&&order!=='MM')return null;const u16=o=>o+2<=end?view.getUint16(o,little):null,u32=o=>o+4<=end?view.getUint32(o,little):null;if(u16(start+2)!==42)return null;const first=u32(start+4);if(first===null)return null;
    const find=offset=>{const pos=start+offset,count=u16(pos);if(count===null||count>512)return null;let nested=null;for(let i=0;i<count;i++){const e=pos+2+i*12;if(e+12>end)break;const tag=u16(e),type=u16(e+2),n=u32(e+4);if(tag===0x8769&&type===4)nested=u32(e+8);if(tag===0x9003&&type===2&&n>0&&n<=128){const field=n<=4?e+8:start+u32(e+8);if(field>=start&&field+n<=end)return parse(ascii(field,n).replace(/\0.*$/,'').trim())}}return nested};
    const result=find(first);if(typeof result==='string')return result;if(Number.isInteger(result)&&result>0){const value=find(result);if(typeof value==='string')return value}return null};
  if(bytes.length<8)return null;
  if(bytes[0]===0xff&&bytes[1]===0xd8){let p=2;while(p+4<bytes.length){if(bytes[p]!==0xff){p++;continue}while(bytes[p]===0xff)p++;const marker=bytes[p++];if(marker===0xda||marker===0xd9)break;if(marker===0xd8||marker===1||(marker>=0xd0&&marker<=0xd7))continue;const size=(bytes[p]<<8)|bytes[p+1];if(size<2)break;const data=p+2;if(marker===0xe1&&ascii(data,6)==='Exif\0\0')return tiff(data+6,size-8);p+=size}return null}
  if((bytes[0]===0x49&&bytes[1]===0x49&&bytes[2]===42&&bytes[3]===0)||(bytes[0]===0x4d&&bytes[1]===0x4d&&bytes[2]===0&&bytes[3]===42))return tiff(0,bytes.length);
  if(ascii(0,8)==='\x89PNG\r\n\x1a\n'){let p=8;while(p+12<=bytes.length){const n=new DataView(bytes.buffer,bytes.byteOffset+p,4).getUint32(0,false),kind=ascii(p+4,4),data=p+8;if(data+n>bytes.length)break;if(kind==='eXIf')return tiff(data,n);p+=12+n}return null}
  if(ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP'){let p=12;while(p+8<=bytes.length){const kind=ascii(p,4),n=new DataView(bytes.buffer,bytes.byteOffset+p+4,4).getUint32(0,true),data=p+8;if(data+n>bytes.length)break;if(kind==='EXIF'){let off=data,len=n;if(ascii(off,6)==='Exif\0\0'){off+=6;len-=6}return tiff(off,len)}p+=8+n+(n%2)}}

  if (ascii(4,4) === 'ftyp') {
    const boxList=(start,end)=>{
      const boxes=[];let p=start;
      while(p+8<=end){let size=new DataView(bytes.buffer,bytes.byteOffset+p,4).getUint32(0,false),header=8,type=ascii(p+4,4);
        if(size===1){if(p+16>end)break;const high=new DataView(bytes.buffer,bytes.byteOffset+p+8,4).getUint32(0,false),low=new DataView(bytes.buffer,bytes.byteOffset+p+12,4).getUint32(0,false);size=high*4294967296+low;header=16}
        else if(size===0)size=end-p;
        if(size<header||p+size>end)break;boxes.push({type,start:p+header,end:p+size});p+=size
      }
      return boxes
    };
    const top=boxList(0,bytes.length),meta=top.find(box=>box.type==='meta');
    if(meta){
      const metaChildren=boxList(meta.start+4,meta.end),iinf=metaChildren.find(box=>box.type==='iinf'),iloc=metaChildren.find(box=>box.type==='iloc');
      let exifId=null;
      if(iinf){const version=bytes[iinf.start],count=version===0?new DataView(bytes.buffer,bytes.byteOffset+iinf.start+4,2).getUint16(0,false):new DataView(bytes.buffer,bytes.byteOffset+iinf.start+4,4).getUint32(0,false),entriesStart=iinf.start+(version===0?6:8);
        for(const entry of boxList(entriesStart,iinf.end)){if(entry.type!=='infe')continue;const v=bytes[entry.start],idOffset=entry.start+4,id=v<3?new DataView(bytes.buffer,bytes.byteOffset+idOffset,2).getUint16(0,false):new DataView(bytes.buffer,bytes.byteOffset+idOffset,4).getUint32(0,false),typeOffset=idOffset+(v<3?4:6);if(ascii(typeOffset,4)==='Exif'){exifId=id;break}}
      }
      if(Number.isInteger(exifId)&&iloc){
        const v=bytes[iloc.start],offsetSize=bytes[iloc.start+4]>>4,lengthSize=bytes[iloc.start+4]&15,baseSize=bytes[iloc.start+5]>>4,indexSize=(v===1||v===2)?bytes[iloc.start+5]&15:0;
        let p=iloc.start+6;const itemCount=v<2?new DataView(bytes.buffer,bytes.byteOffset+p,2).getUint16(0,false):(new DataView(bytes.buffer,bytes.byteOffset+p,4).getUint32(0,false));p+=v<2?2:4;
        const readN=(offset,size)=>{let n=0;for(let i=0;i<size;i++)n=n*256+bytes[offset+i];return n};
        for(let i=0;i<itemCount&&p+4<=iloc.end;i++){
          const id=v<2?new DataView(bytes.buffer,bytes.byteOffset+p,2).getUint16(0,false):new DataView(bytes.buffer,bytes.byteOffset+p,4).getUint32(0,false);p+=v<2?2:4;
          let method=0;if(v===1||v===2){method=new DataView(bytes.buffer,bytes.byteOffset+p,2).getUint16(0,false)&15;p+=2}
          p+=2;const base=readN(p,baseSize);p+=baseSize;const extents=new DataView(bytes.buffer,bytes.byteOffset+p,2).getUint16(0,false);p+=2;
          for(let j=0;j<extents;j++){
            if(indexSize)p+=indexSize;const offset=readN(p,offsetSize);p+=offsetSize;const length=readN(p,lengthSize);p+=lengthSize;
            if(id!==exifId||j!==0||method!==0||length<8)continue;
            const itemStart=base+offset;if(itemStart+4>bytes.length)continue;const exifOffset=new DataView(bytes.buffer,bytes.byteOffset+itemStart,4).getUint32(0,false),tiffStart=itemStart+4+exifOffset;
            if(tiffStart<bytes.length)return tiff(tiffStart,Math.min(length,bytes.length-tiffStart))
          }
        }
      }
    }
  }
  return null
}
async function readCaptureDateFromFile(file){
  if(['.heic','.heif'].includes(path.extname(file).toLowerCase()))return readCaptureDate(await fs.readFile(file));
  const handle=await fs.open(file,'r');
  try{const size=(await handle.stat()).size,buffer=Buffer.alloc(Math.min(size,256*1024));if(buffer.length)await handle.read(buffer,0,buffer.length,0);return readCaptureDate(buffer)}
  finally{await handle.close()}
}
async function scanCaptureDateBatches(since,through,minimum,onProgress,auditBefore=since){
  const directories=await scanPictureFolders(onProgress),counts=new Map();
  const total=directories.reduce((sum,folder)=>sum+folder.imageCount,0);
  let scanned=0,dated=0,unreadable=0,earliestDate=null,beforeCutoff=0;
  if(onProgress)onProgress({type:'start',total,folders:directories.length,since,through,minimum,auditBefore});
  for(const folder of directories){
    const rel=Buffer.from(folder.id,'base64url').toString('utf8'),directory=path.resolve(photoRoot,rel);
    if(directory!==photoRoot&&!insidePhotoRoot(directory))continue;
    let entries;
    try{entries=await fs.readdir(directory,{withFileTypes:true})}
    catch(error){if(['EACCES','EPERM','ENOENT'].includes(error.code))continue;throw error}
    for(const entry of entries){
      if(!entry.isFile()||!extensions.has(path.extname(entry.name).toLowerCase()))continue;
      scanned++;
      try{
        const date=await readCaptureDateFromFile(path.join(directory,entry.name));
        if(!date)unreadable++;
        else{
          dated++;
          if(!earliestDate||date<earliestDate)earliestDate=date;
          if(date<auditBefore)beforeCutoff++;
          if(date>=since&&date<=through){
            const count=(counts.get(date)||0)+1;counts.set(date,count);
            if(onProgress&&count>=minimum&&(count===minimum||count%10===0))onProgress({type:'match',date,count});
          }
        }
      }catch{unreadable++}
      if(onProgress&&(scanned===1||scanned%10===0||scanned===total))onProgress({type:'progress',scanned,total,dated,unreadable,earliestDate,beforeCutoff,flagged:counts.size});
    }
  }
  const result={root:path.basename(photoRoot),scanned,dated,unreadable,earliestDate,beforeCutoff,auditBefore,since,through,minimum,
    dates:[...counts.entries()].filter(([,n])=>n>=minimum).sort((a,b)=>a[0].localeCompare(b[0])).map(([date,count])=>({date,count}))};
  if(onProgress)onProgress({type:'complete',result});
  return result;
}


function normalizeExifOriginal(value) {
  const m=String(value||'').match(/^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  if(!m)return null;
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  const hour=Number(m[4]||0),minute=Number(m[5]||0),second=Number(m[6]||0);
  const check=new Date(Date.UTC(year,month-1,day,hour,minute,second));
  if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day||hour>23||minute>59||second>60)return null;
  return {date:m[1]+'-'+m[2]+'-'+m[3],dateTimeOriginal:m[1]+':'+m[2]+':'+m[3]+(m[4]?' '+m[4]+':'+m[5]+':'+m[6]:'')};
}

async function enumerateAllPhonePhotos(emit) {
  const pending=[photoRoot],files=[],seen=new Set(),extensionCounts=Object.create(null);
  let foldersVisited=0,skippedFolders=0;
  while(pending.length) {
    const directory=pending.pop();foldersVisited++;
    let entries;
    try { entries=await fs.readdir(directory,{withFileTypes:true}); }
    catch(error) {
      if(['EACCES','EPERM','ENOENT'].includes(error.code)) {
        skippedFolders++;
        if(emit)emit({type:'folder-progress',foldersVisited,filesFound:files.length,skippedFolders});
        continue;
      }
      throw error;
    }
    for(const entry of entries) {
      const file=path.resolve(directory,entry.name);
      if(!insidePhotoRoot(file))continue;
      if(entry.isDirectory())pending.push(file);
      else if(entry.isFile()) {
        const ext=path.extname(entry.name).toLowerCase();
        if(!datePhotoExtensions.has(ext)||seen.has(file))continue;
        seen.add(file);files.push(file);extensionCounts[ext]=(extensionCounts[ext]||0)+1;
      }
    }
    if(emit&&foldersVisited%10===0)emit({type:'folder-progress',foldersVisited,filesFound:files.length,skippedFolders});
  }
  files.sort((a,b)=>path.relative(photoRoot,a).localeCompare(path.relative(photoRoot,b),undefined,{numeric:true}));
  return {files,foldersVisited,skippedFolders,extensionCounts};
}

function runExifToolBatch(files) {
  return new Promise((resolve,reject)=>{
    const child=spawn('exiftool',['-json','-EXIF:DateTimeOriginal','-SourceFile',...files],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8')});
    child.stderr.on('data',chunk=>{if(stderr.length<12000)stderr+=chunk.toString('utf8').slice(0,12000-stderr.length)});
    child.once('error',error=>reject(error));
    child.once('close',code=>{
      try {const rows=JSON.parse(stdout||'[]');resolve({rows:Array.isArray(rows)?rows:[],code,stderr})}
      catch(error){reject(new Error('ExifTool returned unreadable output: '+(stderr||error.message).slice(0,500)))}
    });
  });
}

async function scanAllPhonePhotoDates(minimum,emit) {
  const enumeration=await enumerateAllPhonePhotos(emit),total=enumeration.files.length;
  let scanned=0,readable=0,missing=0,readErrors=0,earliestDate=null;
  const daily=new Map(),batchSize=100;
  emit({type:'start',total,foldersVisited:enumeration.foldersVisited,skippedFolders:enumeration.skippedFolders,extensionCounts:enumeration.extensionCounts,minimum,extractor:'ExifTool EXIF:DateTimeOriginal'});
  for(let offset=0;offset<total;offset+=batchSize) {
    const batch=enumeration.files.slice(offset,offset+batchSize);
    let rows=[],batchError=null;
    try {const result=await runExifToolBatch(batch);rows=result.rows;if(result.code!==0&&result.stderr)batchError=result.stderr.slice(0,500)}
    catch(error){if(error.code==='ENOENT')throw new Error('ExifTool is missing. In Termux, run: pkg install exiftool -y');if(error.code)throw new Error('Could not run ExifTool: '+error.message);batchError=error.message}
    const byFile=new Map(rows.filter(row=>typeof row.SourceFile==='string').map(row=>[path.resolve(row.SourceFile),row]));
    for(const file of batch) {
      const row=byFile.get(file),raw=row?.['EXIF:DateTimeOriginal']||row?.DateTimeOriginal,original=normalizeExifOriginal(raw);
      const readError=!row||Boolean(row.Error)||(!row&&Boolean(batchError));
      const relative=path.relative(photoRoot,file),ext=path.extname(file).toLowerCase();
      const photo={id:Buffer.from(relative).toString('base64url'),name:path.basename(file),location:relative,extension:ext,
        dateTimeOriginal:original?.dateTimeOriginal||null,captureDate:original?.date||null,hasOriginalDate:Boolean(original),readError,
        previewable:['.jpg','.jpeg','.jpe','.jfif','.png','.webp','.gif','.bmp','.avif','.heic','.heif'].includes(ext)};
      scanned++;
      if(original) {
        readable++;
        if(!earliestDate||original.date<earliestDate)earliestDate=original.date;
        let photos=daily.get(original.date);if(!photos){photos=[];daily.set(original.date,photos)}photos.push(photo);
        if(photos.length===minimum)emit({type:'group',date:original.date,count:photos.length,photos:photos.slice()});
        else if(photos.length>minimum)emit({type:'group-photo',date:original.date,count:photos.length,photo});
      } else missing++;
      if(readError)readErrors++;
      emit({type:'photo',photo,scanned,total,readable,missing,readErrors,earliestDate});
    }
    emit({type:'progress',scanned,total,readable,missing,readErrors,earliestDate,completedPercent:total?Math.floor(scanned*100/total):100});
  }
  const groups=[...daily.entries()].filter(([,photos])=>photos.length>=minimum)
    .map(([date,photos])=>({date,count:photos.length})).sort((a,b)=>a.date.localeCompare(b.date));
  emit({type:'complete',result:{root:path.basename(photoRoot),scanned,readable,missing,readErrors,earliestDate,
    skippedFolders:enumeration.skippedFolders,foldersVisited:enumeration.foldersVisited,
    extensionCounts:enumeration.extensionCounts,minimum,groups,extractor:'ExifTool EXIF:DateTimeOriginal'}});
}


function isInside(base, file) {
  const relative = path.relative(base, file);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function insideRoot(file) { return isInside(root, file); }
function insidePhotoRoot(file) { return isInside(photoRoot, file); }

function publicPhoto(file) {
  const relative = path.relative(photoRoot, file);
  return {
    id: Buffer.from(relative).toString('base64url'),
    name: path.basename(file),
    location: relative,
    previewable: !['.tif', '.tiff', '.heic', '.heif'].includes(path.extname(file).toLowerCase())
  };
}

async function scan() {
  if (phoneMode) {
    try {
      const entries = await fs.readdir(photoRoot, { withFileTypes: true });
      folders = entries
        .filter(entry => entry.isDirectory() && /^[a-zA-Z0-9 _-]+$/.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new Error('Termux cannot read this folder yet. Run termux-setup-storage and grant file access.');
      }
      throw error;
    }
    if (!folders.length) throw new Error('Create destination folders directly inside the selected photo folder, then scan again.');
  } else {
    folders = defaultFolders;
  }
  const found = [];
  const pending = [photoRoot];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ENOENT') continue;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (!insidePhotoRoot(file)) continue;
      if (entry.isDirectory()) {
        if (!phoneMode && file !== sortedRoot && !['.git', 'node_modules'].includes(entry.name)) pending.push(file);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        found.push(file);
      }
    }
  }
  found.sort((a, b) => path.relative(photoRoot, a).localeCompare(path.relative(photoRoot, b), undefined, { numeric: true }));
  photos = new Map(found.map(file => [publicPhoto(file).id, file]));
  return list();
}

async function resolveFolder(id) {
  const relative = Buffer.from(String(id || ''), 'base64url').toString();
  const directory = path.resolve(photoRoot, relative);
  if (directory !== photoRoot && !insidePhotoRoot(directory)) throw new Error('Invalid folder');
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid folder');
  return { relative: relative || '.', directory };
}

async function selectPictureFolder(id) {
  const relative = Buffer.from(String(id || ''), 'base64url').toString();
  const directory = path.resolve(photoRoot, relative);
  if (directory !== photoRoot && !insidePhotoRoot(directory)) throw new Error('Invalid picture folder');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const found = entries.filter(e => e.isFile() && extensions.has(path.extname(e.name).toLowerCase()))
    .map(e => path.join(directory, e.name))
    .sort((a,b)=>path.basename(a).localeCompare(path.basename(b),undefined,{numeric:true}));
  photos = new Map(found.map(file => [publicPhoto(file).id, file]));
  selectedDirectory = directory;
  return { folder: relative || '.', photos: [...photos.values()].map(publicPhoto) };
}

function list() {
  return { root: path.basename(photoRoot), phoneMode, folders, pictureFolders, photos: [...photos.values()].map(publicPhoto) };
}

function cors(request, response) {
  const origin = request.headers.origin || '';
  if (origin === 'https://chunter-gh.github.io' || origin === 'https://chunter.onrender.com' || origin === 'https://familytree-gprw.onrender.com' || origin === 'http://127.0.0.1:3000' || origin === 'http://localhost:3000') {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
}
function json(response, code, value) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request, maxBytes = 4096) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > maxBytes) throw new Error('Request is too large');
  }
  return JSON.parse(raw || '{}');
}

async function setDestination(slot, id) {
  const n = Number(slot);
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new Error('Destination slot must be 1 through 12');
  const resolved = await resolveFolder(id);
  destinationFolders.set(String(n), resolved);
  return { slot: String(n), folder: resolved.relative, name: path.basename(resolved.directory) || resolved.relative };
}


async function pictureFolderTree(id){
  const picturesRoot=path.resolve(photoRoot,'Pictures');
  await fs.mkdir(picturesRoot,{recursive:true});
  let directory=picturesRoot;
  if(id){const resolved=await resolveFolder(id);directory=resolved.directory}
  if(directory!==photoRoot&&!insidePhotoRoot(directory))throw new Error('Folder is outside phone storage');
  let visited=0;const maxFolders=5000,maxDepth=24;
  async function build(folderPath,depth,shallow=false){
    visited++;
    const info=await fs.lstat(folderPath);
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Folder is not safe');
    const entries=await fs.readdir(folderPath,{withFileTypes:true});
    let imageCount=0;const childDirs=[];
    for(const entry of entries){
      const full=path.join(folderPath,entry.name);
      if(entry.isFile()&&extensions.has(path.extname(entry.name).toLowerCase()))imageCount++;
      if(!entry.isDirectory())continue;
      try{const childInfo=await fs.lstat(full);if(childInfo.isDirectory()&&!childInfo.isSymbolicLink())childDirs.push(full)}catch{}
    }
    childDirs.sort((x,y)=>path.basename(x).localeCompare(path.basename(y),undefined,{numeric:true}));
    const children=[];let truncated=false;
    for(const child of childDirs){
      if(visited>=maxFolders||depth>=maxDepth){truncated=true;break}
      if(shallow){
        try{
          const childEntries=await fs.readdir(child,{withFileTypes:true}),childRelative=path.relative(photoRoot,child);
          children.push({id:Buffer.from(childRelative).toString('base64url'),name:path.basename(child),location:child,imageCount:childEntries.filter(e=>e.isFile()&&extensions.has(path.extname(e.name).toLowerCase())).length,folderCount:childEntries.filter(e=>e.isDirectory()).length,children:[]});
          visited++;
        }catch(error){children.push({id:Buffer.from(path.relative(photoRoot,child)).toString('base64url'),name:path.basename(child),location:child,imageCount:0,folderCount:0,children:[],error:error.message})}
      }else{
        try{children.push(await build(child,depth+1,false))}catch(error){children.push({id:Buffer.from(path.relative(photoRoot,child)).toString('base64url'),name:path.basename(child),location:child,imageCount:0,folderCount:0,children:[],error:error.message})}
      }
    }
    const relative=path.relative(photoRoot,folderPath)||'.';
    return {id:Buffer.from(relative).toString('base64url'),parentId:relative==='.'?null:Buffer.from(path.dirname(relative)||'.').toString('base64url'),name:relative==='.'?'Phone storage':path.basename(folderPath),location:folderPath,imageCount,folderCount:childDirs.length,children,truncated};
  }
  const root=await build(directory,0,directory===photoRoot);
  return {root,location:directory,truncated:visited>=maxFolders};
}

async function renameFolder(id, name) {
  const clean = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\\s+/g, ' ');
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid folder name');
  if (clean.length > 80) throw new Error('Folder name is too long');
  const resolved = await resolveFolder(id);
  const source = resolved.directory;
  if (source === photoRoot || source === path.resolve(photoRoot, 'Pictures')) throw new Error('The storage root and Pictures root cannot be renamed');
  const info = await fs.lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Folder is not safe to rename');
  const parent = path.dirname(source);
  const sourceName = path.basename(source);
  const target = path.join(parent, clean);
  if (path.dirname(target) !== parent) throw new Error('Invalid folder name');
  if (clean === sourceName) return { id, name: clean, location: path.relative(photoRoot, source) };

  const siblings = await fs.readdir(parent, { withFileTypes: true });
  const exactSibling = siblings.find(entry => entry.name === clean);
  if (exactSibling) throw new Error('A folder with that name already exists');

  const caseOnlyRename = sourceName.toLocaleLowerCase('en-US') === clean.toLocaleLowerCase('en-US');
  if (!caseOnlyRename) {
    await fs.rename(source, target);
  } else {
    // Route case-only changes through a unique temporary name. This works on
    // case-insensitive filesystems while the exact-name check above catches
    // a genuinely different sibling on case-sensitive filesystems.
    let temporary;
    do { temporary = path.join(parent, '.pixsort-rename-' + randomUUID()); }
    while (await fs.lstat(temporary).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)));
    await fs.rename(source, temporary);
    try { await fs.rename(temporary, target); }
    catch (error) {
      await fs.rename(temporary, source).catch(() => {});
      if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
        throw new Error('A folder with that name already exists');
      }
      throw error;
    }
  }
  for (const [slot, assigned] of destinationFolders) {
    if (assigned.directory === source || isInside(source, assigned.directory)) {
      destinationFolders.set(slot, { ...assigned, directory: path.join(target, path.relative(source, assigned.directory)) });
    }
  }
  if (selectedDirectory === source || (selectedDirectory && isInside(source, selectedDirectory))) {
    selectedDirectory = path.join(target, path.relative(source, selectedDirectory));
  }
  photos.clear();
  const relative = path.relative(photoRoot, target);
  return { id: Buffer.from(relative).toString('base64url'), name: clean, location: relative };
}
function resolvePhotoPath(id) {
  if (typeof id !== 'string' || !id || id.length > 4096) throw new Error('Invalid picture');
  let relative;
  try { relative = Buffer.from(id, 'base64url').toString('utf8'); } catch { throw new Error('Invalid picture'); }
  if (!relative || relative.includes('\\0') || path.isAbsolute(relative)) throw new Error('Invalid picture');
  const file = path.resolve(photoRoot, relative);
  if (!insidePhotoRoot(file)) throw new Error('Picture is outside phone storage');
  return { relative, file };
}
async function checkedPhoto(id) {
  const resolved = resolvePhotoPath(id), info = await fs.lstat(resolved.file);
  if (!info.isFile() || info.isSymbolicLink() || !extensions.has(path.extname(resolved.file).toLowerCase())) throw new Error('Picture is not a safe image file');
  return { ...resolved, directory: path.dirname(resolved.file) };
}
async function renamePhoto(id, name) {
  const photo = await checkedPhoto(id);
  let clean = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\\s+/g, ' ');
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid picture name');
  if (clean.length > 200) throw new Error('Picture name is too long');
  const originalExtension = path.extname(photo.file);
  const typedExtension = path.extname(clean);
  if (typedExtension && extensions.has(typedExtension.toLowerCase())) clean = clean.slice(0, -typedExtension.length);
  clean += originalExtension;
  const target = path.join(photo.directory, clean);
  if (path.dirname(target) !== photo.directory) throw new Error('Invalid picture name');
  if (target === photo.file) return publicPhoto(photo.file);
  const siblings = await fs.readdir(photo.directory);
  if (siblings.includes(clean)) throw new Error('A picture with that name already exists');
  const caseOnly = path.basename(photo.file).toLocaleLowerCase('en-US') === clean.toLocaleLowerCase('en-US');
  if (!caseOnly) await fs.rename(photo.file, target);
  else {
    const temporary = path.join(photo.directory, '.pixsort-photo-rename-' + randomUUID());
    await fs.rename(photo.file, temporary);
    try { await fs.rename(temporary, target); }
    catch (error) { await fs.rename(temporary, photo.file).catch(() => {}); throw error; }
  }
  photos.delete(id);
  const result = publicPhoto(target);
  photos.set(result.id, target);
  return result;
}
async function movePhoto(id, destinationId) {
  const photo = await checkedPhoto(id), target = await resolveFolder(destinationId);
  const sourceDirectory = photo.directory;
  if (target.directory === sourceDirectory) throw new Error('That picture is already in this folder');
  const original = path.basename(photo.file), extension = path.extname(original), stem = original.slice(0, -extension.length);
  let destination;
  for (let suffix = 0; ; suffix++) {
    destination = path.join(target.directory, suffix ? stem + ' (' + suffix + ')' + extension : original);
    try { await fs.lstat(destination); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  await fs.rename(photo.file, destination);
  photos.delete(id);
  const result = publicPhoto(destination);
  photos.set(result.id, destination);
  return { ...result, oldLocation: photo.relative, location: result.location, sourceFolderId: Buffer.from(path.relative(photoRoot, sourceDirectory) || '.').toString('base64url'), sourceFolderName: path.basename(sourceDirectory) };
}
async function deletePhoto(id) {
  const photo = await checkedPhoto(id);
  await fs.unlink(photo.file);
  photos.delete(id);
  return { deleted: photo.relative, sourceFolderId: Buffer.from(path.relative(photoRoot, photo.directory) || '.').toString('base64url'), sourceFolderName: path.basename(photo.directory) };
}

async function summarizeFolderForDeletion(id){
  const resolved=await resolveFolder(id),directory=resolved.directory,picturesRoot=path.resolve(photoRoot,'Pictures');
  if(directory===photoRoot||directory===picturesRoot)throw new Error('Cannot delete the storage root or Pictures root');
  let subfolders=0,pictures=0,visited=0;
  async function walk(folderPath,depth){
    if(depth>128)throw new Error('Folder is too deeply nested to delete safely');
    if(++visited>50000)throw new Error('Folder contains too many subfolders to delete safely');
    const info=await fs.lstat(folderPath);
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Folder is not safe to delete');
    const entries=await fs.readdir(folderPath,{withFileTypes:true});
    for(const entry of entries){
      const full=path.join(folderPath,entry.name);
      if(entry.isFile()&&extensions.has(path.extname(entry.name).toLowerCase()))pictures++;
      else if(entry.isDirectory()){
        const childInfo=await fs.lstat(full);
        if(!childInfo.isDirectory()||childInfo.isSymbolicLink())continue;
        subfolders++;await walk(full,depth+1);
      }
    }
  }
  await walk(directory,0);
  return {directory,deleted:resolved.relative,name:path.basename(directory),subfolders,pictures};
}
async function deleteFolder(id){
  const summary=await summarizeFolderForDeletion(id),directory=summary.directory;
  await fs.rm(directory,{recursive:true,force:false});
  for(const [slot,assigned] of destinationFolders){if(assigned.directory===directory||isInside(directory,assigned.directory))destinationFolders.delete(slot)}
  if(selectedDirectory===directory||(selectedDirectory&&isInside(directory,selectedDirectory)))selectedDirectory=null;
  photos.clear();
  const {deleted,name,subfolders,pictures}=summary;
  return {deleted,name,subfolders,pictures};
}

async function deleteEmptyFolder(id) {
  const resolved=await resolveFolder(id);
  if(resolved.directory===photoRoot) throw new Error('Cannot delete the storage root');
  const entries=await fs.readdir(resolved.directory);
  if(entries.length) throw new Error('Folder is no longer empty');
  await fs.rmdir(resolved.directory);
  return {deleted:resolved.relative};
}


async function moveFolder(sourceId,destinationId){
  const sourceResolved=await resolveFolder(sourceId),targetResolved=await resolveFolder(destinationId);
  const source=sourceResolved.directory,targetDirectory=targetResolved.directory,picturesRoot=path.resolve(photoRoot,'Pictures');
  if(source===photoRoot||source===picturesRoot)throw new Error('The storage root and Pictures root cannot be moved');
  if(path.dirname(source)===targetDirectory)throw new Error('Folder is already inside that folder');
  if(source===targetDirectory)throw new Error('Choose a different destination folder');
  if(isInside(source,targetDirectory))throw new Error('A folder cannot be moved into itself or one of its subfolders');
  const sourceInfo=await fs.lstat(source),targetInfo=await fs.lstat(targetDirectory);
  if(!sourceInfo.isDirectory()||sourceInfo.isSymbolicLink()||!targetInfo.isDirectory()||targetInfo.isSymbolicLink())throw new Error('Source or destination folder is not safe');
  const base=path.basename(source);let destination;
  for(let suffix=0;;suffix++){
    destination=path.join(targetDirectory,suffix?base+' ('+suffix+')':base);
    try{await fs.lstat(destination)}catch(error){if(error.code==='ENOENT')break;throw error}
  }
  const oldLocation=sourceResolved.relative;
  await fs.rename(source,destination);
  for(const [slot,assigned] of destinationFolders){
    if(assigned.directory===source||isInside(source,assigned.directory))destinationFolders.set(slot,{...assigned,directory:path.join(destination,path.relative(source,assigned.directory))});
  }
  if(selectedDirectory===source||(selectedDirectory&&isInside(source,selectedDirectory)))selectedDirectory=path.join(destination,path.relative(source,selectedDirectory));
  photos.clear();
  const location=path.relative(photoRoot,destination),id=Buffer.from(location).toString('base64url');
  return {id,name:base,oldLocation,location,movedTo:location,destination:targetResolved.relative};
}

async function sortFolder(id, folder) {
  if (!/^(?:[1-9]|1[0-2])$/.test(String(folder))) return { error: 'Choose destination slot 1 through 12', status: 400 };
  const sourceResolved = await resolveFolder(id);
  const source = sourceResolved.directory;
  if (source === photoRoot) return { error: 'Cannot move the storage root', status: 400 };
  const chosen = destinationFolders.get(String(folder));
  if (!chosen) return { error: 'Assign a destination folder to slot '+folder+' first', status: 400 };
  const targetDirectory = chosen.directory;
  if (source === targetDirectory || isInside(source, targetDirectory)) return { error: 'Cannot move a folder into itself', status: 400 };
  const sourceInfo = await fs.lstat(source);
  const targetInfo = await fs.lstat(targetDirectory);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) return { error: 'Source is not a safe folder', status: 400 };
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) return { error: 'Destination folder is not safe', status: 400 };
  const base = path.basename(source);
  let destination = path.join(targetDirectory, base);
  for (let suffix = 0; ; suffix++) {
    destination = path.join(targetDirectory, suffix ? `${base} (${suffix})` : base);
    try { await fs.stat(destination); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  await fs.rename(source, destination);
  selectedDirectory = null;
  photos.clear();
  return { movedTo: path.relative(photoRoot, destination) };
}

async function sortPhoto(id, folder) {
  if (typeof id !== 'string' || !photos.has(id)) return { error: 'Photo is no longer in the queue', status: 404 };
  if (!/^(?:[1-9]|1[0-2])$/.test(String(folder))) return { error: 'Choose destination slot 1 through 12', status: 400 };
  const source = photos.get(id);
  if (!insidePhotoRoot(source)) return { error: 'Invalid source', status: 400 };
  const sourceInfo = await fs.lstat(source);
  if (!sourceInfo.isFile()) return { error: 'Source is no longer a regular file', status: 400 };
  let targetDirectory;
  if (phoneMode) {
    const chosen = destinationFolders.get(String(folder));
    if (!chosen) return { error: 'Assign a destination folder to slot '+folder+' first', status: 400 };
    targetDirectory = chosen.directory;
    const info = await fs.lstat(targetDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || (targetDirectory !== photoRoot && !insidePhotoRoot(targetDirectory))) return { error: 'Destination folder is not safe', status: 400 };
  } else {
    for (const directory of [sortedRoot, path.join(sortedRoot, folder)]) {
      try {
        const info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) return { error: 'Sorted folder is not a safe directory', status: 400 };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.mkdir(directory);
      }
    }
    targetDirectory = path.join(sortedRoot, folder);
  }
  const original = path.basename(source);
  const extension = path.extname(original);
  const stem = original.slice(0, -extension.length);
  let destination;
  for (let suffix = 0; ; suffix++) {
    destination = path.join(targetDirectory, suffix ? `${stem} (${suffix})${extension}` : original);
    try {
      await fs.stat(destination);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  const sourceDirectory=path.dirname(source);await fs.rename(source, destination);
  photos.delete(id);
  let sourceFolderEmpty=false;
  try { sourceFolderEmpty=(await fs.readdir(sourceDirectory)).length===0; } catch {}
  const sourceRelative=path.relative(photoRoot,sourceDirectory)||'.';
  return { movedTo: path.relative(photoRoot, destination), remaining: photos.size, sourceFolderEmpty, sourceFolderId: Buffer.from(sourceRelative).toString('base64url'), sourceFolderName:path.basename(sourceDirectory)||sourceRelative };
}

const server = http.createServer(async (request, response) => {
  try {
    cors(request, response);
    if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && staticFiles.has(url.pathname)) {
      const [file, type] = staticFiles.get(url.pathname);
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      response.end(await fs.readFile(path.join(root, file)));
    } else if (request.method === 'GET' && url.pathname === '/api/preferred-folders') {
      try {
        const saved = JSON.parse(await fs.readFile(preferredFoldersFile, 'utf8'));
        if (!Array.isArray(saved.folders)) throw new Error('Saved preferred-folder data is invalid');
        json(response, 200, { folders: saved.folders, stored: true });
      } catch (error) {
        if (error.code === 'ENOENT') json(response, 200, { folders: [], stored: false });
        else throw error;
      }
    } else if (request.method === 'POST' && url.pathname === '/api/preferred-folders') {
      const data = await body(request, 65536);
      if (!Array.isArray(data.folders) || data.folders.length > 200) return json(response, 400, { error: 'Preferred folders must be a list of at most 200 items' });
      const folders = [];
      for (const item of data.folders) {
        if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 4096) return json(response, 400, { error: 'A preferred folder has an invalid ID' });
        folders.push({
          id: item.id,
          name: typeof item.name === 'string' ? item.name.slice(0, 256) : '',
          location: typeof item.location === 'string' ? item.location.slice(0, 4096) : ''
        });
      }
      await fs.mkdir(path.dirname(preferredFoldersFile), { recursive: true });
      const temporaryFile = preferredFoldersFile + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporaryFile, JSON.stringify({ folders }, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryFile, preferredFoldersFile);
      json(response, 200, { folders, stored: true });
    } else if (request.method === 'GET' && url.pathname === '/api/date-batches') {
      const roots=['DCIM/Camera','DCIM','Pictures'].map(x=>path.join(photoRoot,x));
      const seen=new Set(),items=[],queue=roots.map(p=>({p,depth:0}));let scanned=0;
      while(queue.length && scanned<40000){
        const {p,depth}=queue.pop();let real;try{real=await fs.realpath(p)}catch{continue}
        if(seen.has(real)||!insidePhotoRoot(real))continue;seen.add(real);
        let entries;try{entries=await fs.readdir(real,{withFileTypes:true})}catch{continue}
        for(const entry of entries){if(scanned>=40000)break;const full=path.join(real,entry.name);
          if(entry.isDirectory()&&depth<12&&!entry.isSymbolicLink()){queue.push({p:full,depth:depth+1});continue}
          if(!entry.isFile()||!extensions.has(path.extname(entry.name).toLowerCase()))continue;
          scanned++;try{const s=await fs.stat(full);items.push({relative:path.relative(photoRoot,full),date:new Date(s.mtimeMs).toISOString().slice(0,10)})}catch{}
        }
      }
      items.sort((a,b)=>a.date.localeCompare(b.date));const days=new Map();
      for(const item of items){if(!days.has(item.date))days.set(item.date,[]);days.get(item.date).push(item)}
      const dates=[...days.keys()].sort(),groups=[];let current=[];
      for(const d of dates){const prev=current.length?Date.parse(current[current.length-1]+'T00:00:00Z'):0;if(current.length&&Date.parse(d+'T00:00:00Z')-prev>2*86400000){groups.push(current);current=[]}current.push(d)}
      if(current.length)groups.push(current);
      const batches=groups.map(g=>({start:g[0],end:g[g.length-1],days:g.length,photos:g.flatMap(d=>days.get(d))})).filter(g=>g.photos.length>=10).sort((a,b)=>b.photos.length-a.photos.length).slice(0,100);
      json(response,200,{scanned:items.length,dateBasis:'file modification date, not EXIF capture date',truncated:scanned>=40000,batches});
    } else if (request.method === 'GET' && url.pathname === '/api/photos') {
      json(response, 200, list());
    } else if (request.method === 'POST' && url.pathname === '/api/scan') {
      json(response, 200, await scan());
    } else if (request.method === 'GET' && url.pathname === '/api/picture-folders') {
      json(response, 200, { root: path.basename(photoRoot), folders: pictureFolders });
    } else if (request.method === 'POST' && url.pathname === '/api/scan-picture-folders') {
      json(response, 200, { root: path.basename(photoRoot), folders: await scanPictureFolders() });
    } else if (request.method === 'GET' && url.pathname === '/api/date-batch-stream') {
      const since = url.searchParams.get('since') || '';
      const through = url.searchParams.get('through') || new Date().toISOString().slice(0, 10);
      const minimum = Math.max(1, Math.min(100000, Number(url.searchParams.get('minimum')) || 50));
      const auditBefore = url.searchParams.get('auditBefore') || since;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(through) || !/^\d{4}-\d{2}-\d{2}$/.test(auditBefore)) return json(response, 400, { error: 'Use YYYY-MM-DD dates for since and through.' });
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      const emit = event => { if (!response.destroyed) response.write(JSON.stringify(event) + '\n'); };
      response.flushHeaders();
      emit({ type: 'status', message: 'Searching phone folders…' });
      try { await scanCaptureDateBatches(since, through, minimum, emit, auditBefore); }
      catch (error) { emit({ type: 'error', message: error.message || 'Phone photo scan failed.' }); }
      response.end();
    } else if (request.method === 'GET' && url.pathname === '/api/date-photo-audit-stream') {
      const minimum=Math.max(1,Math.min(100000,Number(url.searchParams.get('minimum'))||25));
      response.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});
      const emit=event=>{if(!response.destroyed)response.write(JSON.stringify(event)+'\n')};
      response.flushHeaders();
      emit({type:'status',message:'Searching all reachable phone storage for photo files…'});
      try { await scanAllPhonePhotoDates(minimum,emit); }
      catch(error) { emit({type:'error',message:error.message||'Full phone photo scan failed.'}); }
      response.end();
    } else if (request.method === 'GET' && url.pathname === '/api/date-batch-dates') {
      const since = url.searchParams.get('since') || '';
      const through = url.searchParams.get('through') || new Date().toISOString().slice(0, 10);
      const minimum = Math.max(1, Math.min(100000, Number(url.searchParams.get('minimum')) || 50));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(through)) return json(response, 400, { error: 'Use YYYY-MM-DD dates for since and through.' });
      json(response, 200, await scanCaptureDateBatches(since, through, minimum));
    } else if (request.method === 'GET' && url.pathname === '/api/destination-folders') {
      json(response, 200, { root: 'Pictures', folders: await scanDestinationFolders() });
    } else if (request.method === 'POST' && url.pathname === '/api/create-destination-folder') {
      const { name } = await body(request);
      json(response, 200, await createDestinationFolder(name));
    } else if (request.method === 'POST' && url.pathname === '/api/create-folder') {
      const { parentId, name } = await body(request);
      json(response, 200, await createFolderIn(parentId, name));
    } else if (request.method === 'POST' && url.pathname === '/api/select-picture-folder') {
      const { id } = await body(request);
      json(response, 200, await selectPictureFolder(id));
    } else if (request.method === 'POST' && url.pathname === '/api/set-destination') {
      const { slot, id } = await body(request);
      json(response, 200, await setDestination(slot, id));
    } else if (request.method === 'POST' && url.pathname === '/api/move-folder') {
      const { sourceId, destinationId } = await body(request);
      json(response, 200, await moveFolder(sourceId, destinationId));
    } else if (request.method === 'GET' && url.pathname === '/api/picture-folder-tree') {
      json(response, 200, await pictureFolderTree(url.searchParams.get('id')));
    } else if (request.method === 'POST' && url.pathname === '/api/rename-folder') {
      const { id, name } = await body(request);
      json(response, 200, await renameFolder(id, name));
    } else if (request.method === 'GET' && url.pathname === '/api/date-photo') {
      const id=url.searchParams.get('id')||'';
      if(!/^[A-Za-z0-9_-]{1,4096}$/.test(id))return json(response,400,{error:'Invalid photo ID'});
      const relative=Buffer.from(id,'base64url').toString('utf8'),file=path.resolve(photoRoot,relative);
      if(!insidePhotoRoot(file))return json(response,400,{error:'Photo is outside phone storage'});
      let info;
      try{info=await fs.lstat(file)}catch{return json(response,404,{error:'Photo not found'})}
      if(!info.isFile()||info.isSymbolicLink()||!datePhotoExtensions.has(path.extname(file).toLowerCase()))return json(response,404,{error:'Photo not found'});
      response.writeHead(200,{'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      response.end(await fs.readFile(file));
    } else if (request.method === 'GET' && url.pathname === '/api/thumbnail') {
      const wanted = (url.searchParams.get('name') || '1.jpg').toLowerCase();
      let file = [...photos.values()].find(f => path.basename(f).toLowerCase() === wanted);
      if (!file) {
        const direct = path.join(photoRoot, wanted);
        try {
          const stat = await fs.lstat(direct);
          if (stat.isFile() && insidePhotoRoot(direct)) file = direct;
        } catch {}
      }
      if (!file || !insidePhotoRoot(file)) return json(response, 404, { error: 'Thumbnail not found' });
      const stat = await fs.lstat(file);
      response.writeHead(200, {
        'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(await fs.readFile(file));
    } else if (request.method === 'GET' && url.pathname === '/api/photo') {
      const file = photos.get(url.searchParams.get('id'));
      if (!file || !insidePhotoRoot(file)) return json(response, 404, { error: 'Photo not found' });
      const stat = await fs.lstat(file);
      if (!stat.isFile()) return json(response, 404, { error: 'Photo not found' });
      response.writeHead(200, {
        'Content-Type': mime[path.extname(file).toLowerCase()],
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(await fs.readFile(file));
    } else if (request.method === 'POST' && url.pathname === '/api/rename-picture') {
      const { id, name } = await body(request);
      json(response, 200, await renamePhoto(id, name));
    } else if (request.method === 'POST' && url.pathname === '/api/move-picture') {
      const { id, destinationId } = await body(request);
      json(response, 200, await movePhoto(id, destinationId));
    } else if (request.method === 'POST' && url.pathname === '/api/delete-picture') {
      const { id } = await body(request);
      json(response, 200, await deletePhoto(id));
    } else if (request.method === 'POST' && url.pathname === '/api/delete-folder-preview') {
      const { id } = await body(request);
      const { name, subfolders, pictures } = await summarizeFolderForDeletion(id);
      json(response, 200, { name, subfolders, pictures });
    } else if (request.method === 'POST' && url.pathname === '/api/delete-folder') {
      const { id, confirmed } = await body(request);
      if (confirmed !== true) return json(response, 400, { error: 'Folder deletion requires confirmation' });
      json(response, 200, await deleteFolder(id));
    } else if (request.method === 'POST' && url.pathname === '/api/delete-empty-folder') {
      const { id } = await body(request);
      json(response, 200, await deleteEmptyFolder(id));
    } else if (request.method === 'POST' && url.pathname === '/api/sort-folder') {
      const { id, folder } = await body(request);
      const result = await sortFolder(id, folder);
      json(response, result.status || 200, result);
    } else if (request.method === 'POST' && url.pathname === '/api/sort') {
      const { id, folder } = await body(request);
      const result = await sortPhoto(id, folder);
      json(response, result.status || 200, result);
    } else {
      json(response, 404, { error: 'Not found' });
    }
  } catch (error) {
    console.error(error);
    json(response, 500, { error: error.message || 'Unexpected error' });
  }
});

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
server.listen(port, host, async () => {
  console.log(`Pic Flip To Sort V49 Termux is ready at http://${host}:${port}`);
  if (phoneMode) {
    try {
      const found = await scanPictureFolders();
      console.log(`V49 found ${found.length} folders containing pictures under ${photoRoot}`);
    } catch (error) { console.error('V49 picture-folder scan failed:', error.message); }
  }
});