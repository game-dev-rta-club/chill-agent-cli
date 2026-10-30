import test from 'node:test';
import assert from 'node:assert/strict';
import {imageSize} from '../lib/image-size.mjs';
import {briefDocument} from '../lib/brief.mjs';

const png=(width,height)=>{const data=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a0000000d49484452','hex').copy(data);data.writeUInt32BE(width,16);data.writeUInt32BE(height,20);return data;};
const riff=(chunk,payload)=>Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'+chunk,'latin1'),Buffer.alloc(4),payload]);
function jpeg(width,height,orientation) {
  const segments=[Buffer.from([0xff,0xd8])];
  if(orientation){
    const tiff=Buffer.alloc(26);tiff.write('MM',0,'latin1');tiff.writeUInt16BE(42,2);tiff.writeUInt32BE(8,4);tiff.writeUInt16BE(1,8);
    tiff.writeUInt16BE(0x0112,10);tiff.writeUInt16BE(3,12);tiff.writeUInt32BE(1,14);tiff.writeUInt16BE(orientation,18);
    const body=Buffer.concat([Buffer.from('Exif\0\0','latin1'),tiff]),head=Buffer.from([0xff,0xe1,0,0]);head.writeUInt16BE(body.length+2,2);segments.push(head,body);
  }
  const sof=Buffer.from([0xff,0xc0,0,11,8,0,0,0,0,1,1,0x11,0]);sof.writeUInt16BE(height,5);sof.writeUInt16BE(width,7);
  return Buffer.concat([...segments,sof,Buffer.from([0xff,0xd9])]);
}

test('image sizes come from PNG, JPEG and WebP headers',()=>{
  assert.deepEqual(imageSize(png(1200,800)),{width:1200,height:800});
  assert.deepEqual(imageSize(jpeg(640,480)),{width:640,height:480});
  // A phone photo stored sideways shows turned, as the browser draws it.
  assert.deepEqual(imageSize(jpeg(640,480,6)),{width:480,height:640});
  assert.deepEqual(imageSize(jpeg(640,480,3)),{width:640,height:480});
  const vp8x=Buffer.alloc(10);vp8x.writeUIntLE(1919,4,3);vp8x.writeUIntLE(1079,7,3);
  assert.deepEqual(imageSize(riff('VP8X',vp8x)),{width:1920,height:1080});
  const vp8l=Buffer.alloc(10);vp8l[0]=0x2f;vp8l.writeUInt32LE((299)|(199<<14),1);
  assert.deepEqual(imageSize(riff('VP8L',vp8l)),{width:300,height:200});
  const vp8=Buffer.alloc(10);vp8.set([0x9d,0x01,0x2a],3);vp8.writeUInt16LE(320,6);vp8.writeUInt16LE(240,8);
  assert.deepEqual(imageSize(riff('VP8 ',vp8)),{width:320,height:240});
  for(const bad of [Buffer.from('not an image'),png(0,10),Buffer.from([0xff,0xd8,0xff])])assert.equal(imageSize(bad),null);
});

test('a Canvas image with a known size reserves its box and shows a placeholder',()=>{
  const id='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222';
  const doc=briefDocument(`<img src="/api/images/${id}"><img width="200" src="/api/images/${id}"><img src="/api/images/${other}">`,{[id]:{width:800,height:600}});
  const images=doc.match(/<img[^>]*>/g);
  assert.match(images[0],/width="800" height="600" data-image-placeholder/);
  assert.match(images[1],/width="200".*height="150" data-image-placeholder/);
  assert.doesNotMatch(images[2],/placeholder|width/);
  assert.match(doc,/img\[data-image-placeholder\]\{background:/);
});
