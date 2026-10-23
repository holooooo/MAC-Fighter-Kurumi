#!/usr/bin/env python3
"""Rebuild only from the user-approved ArtArch JPEG and its three Seedance videos.
No network or generation. Local affine edits are labeled separately from footage.
Requires the bundled Python's Pillow and numpy, and a local ffmpeg.
"""
from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np
import subprocess, json, math, hashlib, shutil

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'assets/kurumi-gifs'
OUT.mkdir(parents=True,exist_ok=True)
W,H=336,452
FFMPEG=shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'
REFERENCE=ROOT/'output/kurumi-generated-reference/AA4vCOxNi9Wh_dGLJr7B8rb-1-nanobanana_3aca59b6.jpg'
LABELS={'wave':'挥手打招呼','stretch':'舒展双臂','loss':'被套还嘴硬','buy':'想加仓又管住手'}


# Estimate local foreground and background, recover fractional alpha, and unmix
# edge RGB. Do not merely clamp green or discard half-transparent hair pixels.
import importlib.util
_matte_spec=importlib.util.spec_from_file_location('character_matte',ROOT/'scripts/character-matte.py')
_matte=importlib.util.module_from_spec(_matte_spec);_matte_spec.loader.exec_module(_matte)
key=_matte.key


def decode(name):
    record=json.loads((ROOT/f'output/kurumi-correct-{name}-retry.json').read_text())
    assert record['state']=='done' and record['ok']
    video=Path(record['downloads'][0]['path'])
    info=json.loads(subprocess.check_output(['/opt/homebrew/bin/ffprobe','-v','error','-show_entries','stream=width,height','-of','json',str(video)]))['streams'][0]
    w,h=info['width'],info['height']
    raw=subprocess.check_output([FFMPEG,'-v','error','-i',str(video),'-vf','fps=12','-f','rawvideo','-pix_fmt','rgb24','-'])
    array=np.frombuffer(raw,dtype=np.uint8).reshape(-1,h,w,3)
    return [key(Image.fromarray(frame)) for frame in array],record['runId']

clips={};runs={}
for name in ['wave','loss','fomo']:
    clips[name],runs[name]=decode(name)

# All clips share one fixed crop/scale anchored to source screen, never frame-by-frame
# bounding-box normalization (that would make the character wobble/resize).
all_boxes=[]
for seq in clips.values():
    for f in seq:
        a=f.getchannel('A').point(lambda p:255 if p>100 else 0)
        all_boxes.append(a.getbbox())
x0=min(b[0] for b in all_boxes);y0=min(b[1] for b in all_boxes)
x1=max(b[2] for b in all_boxes);y1=max(b[3] for b in all_boxes)
scale=min((W-24)/(x1-x0),(H-32)/(y1-y0))
center=(x0+x1)/2
bottom=y1

def normalize(frame):
    new=frame.resize((round(frame.width*scale),round(frame.height*scale)),Image.Resampling.LANCZOS)
    canvas=Image.new('RGBA',(W,H))
    canvas.alpha_composite(new,(round(W/2-center*scale),round(H-16-bottom*scale)))
    return canvas
clips={k:[normalize(f) for f in seq] for k,seq in clips.items()}
# Canonical static reference is keyed, resized to same body-height and footline.
seed=key(Image.open(REFERENCE));box=seed.getchannel('A').point(lambda p:255 if p>100 else 0).getbbox()
seed=seed.crop(box)
height=round((all_boxes[0][3]-all_boxes[0][1])*scale)
seed=seed.resize((round(seed.width*height/seed.height),height),Image.Resampling.LANCZOS)
base=Image.new('RGBA',(W,H));base.alpha_composite(seed,((W-seed.width)//2,H-16-height))
base.save(ROOT/'assets/kurumi-generated-idle.png')


def shift(f,dx=0,dy=0,sx=1,sy=1,anchor=(168,436)):
    ax,ay=anchor
    return f.transform((W,H),Image.Transform.AFFINE,(1/sx,0,ax-ax/sx-dx/sx,0,1/sy,ay-ay/sy-dy/sy),Image.Resampling.BICUBIC)


def local(t,name):
    e=math.sin(math.pi*t)**2
    if name=='idle':return shift(base,sy=1+.006*math.sin(2*math.pi*t))
    if name=='press':return shift(base,sx=1+.03*e,sy=1-.025*e)
    if name=='landing':return shift(base,sx=1+.045*e,sy=1-.04*e)
    if name=='dragging':return shift(base,dy=-6).rotate(3*math.sin(2*math.pi*t),Image.Resampling.BICUBIC,center=(168,110))
    if name in ['look','sway']:return base.rotate((2 if name=='look' else 3)*math.sin(2*math.pi*t),Image.Resampling.BICUBIC,center=(168,436))
    return base.copy()


def segment(source,start,end,n):
    frames=clips[source]
    return [frames[min(len(frames)-1,max(0,round((start+(end-start)*i/(n-1))*12)))].copy() for i in range(n)]

samples=[base]
for seq in clips.values(): samples.extend(seq[::4])
palette_src=Image.new('RGB',(W*8,H*math.ceil(len(samples)/8)),(255,245,250))
for i,f in enumerate(samples):
    bg=Image.new('RGBA',(W,H),(255,245,250,255));bg.alpha_composite(f)
    palette_src.paste(bg.convert('RGB'),((i%8)*W,(i//8)*H))
palette=palette_src.quantize(colors=224,method=Image.Quantize.MEDIANCUT)
manifest={'version':3,'runtimeFormat':'apng-rgba8','gifTransparency':'binary-compatibility-only','width':W,'height':H,'displaySize':{'width':230,'height':240},'poster':'assets/kurumi-generated-idle.png',
    'canonical':{'node':'A4vCOxNi9Wh_dGLJr7B8rb','title':'久留美二头身统一人设·低价单张打样','sha256':hashlib.sha256(REFERENCE.read_bytes()).hexdigest()},
    'source':{'model':'doubao-seedance-2-0-mini-260128','runs':runs,'rejectedSvgPilot':'6d7be9db-4a4d-4ccf-aae0-6de30029eb16','credits':36,'localEditingCredits':0},
    'animations':{}}
contact=[]

def save(name,seq,ms,loop,method,description,source=None):
    images=[]
    for f in seq:
        a=np.array(f);a[a[:,:,3]<128,:3]=[255,245,250]
        p=Image.fromarray(a[:,:,:3]).quantize(palette=palette,dither=Image.Dither.NONE)
        indices=np.array(p);indices[a[:,:,3]<128]=255
        p=Image.fromarray(indices);p.putpalette(palette.getpalette());p.info['transparency']=255
        images.append(p)
    durations=[round((i+1)*ms/len(seq)/10)*10-round(i*ms/len(seq)/10)*10 for i in range(len(seq))]
    options=dict(save_all=True,append_images=images[1:],duration=durations,disposal=2,transparency=255,optimize=False)
    if loop:options['loop']=0
    path=OUT/f'{name}.gif';images[0].save(path,**options)
    # APNG retains 8-bit alpha; GIF is compatibility export only (binary alpha).
    alpha_dir=ROOT/'assets/kurumi-apng';alpha_dir.mkdir(parents=True,exist_ok=True)
    alpha_path=alpha_dir/f'{name}.png'
    seq[0].save(alpha_path,format='PNG',save_all=True,append_images=seq[1:],
        duration=durations,loop=0 if loop else 1,disposal=0,blend=0,compress_level=7)
    with Image.open(path) as encoded:
        decoded_frames=encoded.n_frames
        total=sum(encoded.seek(i) or encoded.info.get('duration',0) for i in range(encoded.n_frames))
    manifest['animations'][name]={'file':f'assets/kurumi-gifs/{name}.gif','durationMs':total,'loop':loop,'frames':decoded_frames,
        'method':method,'description':description,'sourceRun':runs.get(source) if source else None,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'runtimeFile':f'assets/kurumi-apng/{name}.png','runtimeBytes':alpha_path.stat().st_size,'runtimeSha256':hashlib.sha256(alpha_path.read_bytes()).hexdigest()}
    contact.append((name,seq[len(seq)//2]))

for name,n,ms,loop,desc in [('idle',24,2000,True,'原人设轻呼吸'),('look',20,1600,False,'轻轻倾身观察'),('sway',20,1600,False,'左右轻摆'),('press',5,320,False,'点击压缩回弹'),('dragging',12,1000,True,'被提起轻晃'),('landing',6,360,False,'落地回弹')]:
    seq=[local(i/(n if loop else n-1),name) for i in range(n)]
    save(name,seq,ms,loop,'canonical-raster-local-transform',desc)

# Generated gestures use genuine frames, no painted limbs or SVG-derived anatomy.
for name,source,start,end,n,ms,desc in [
    ('wave','wave',0,.95,20,1600,'抬手挥两下'),('stretch','wave',1,3,20,1600,'闭眼伸展双臂'),
    ('profit','wave',1.15,3,26,2200,'双臂展开开心庆祝'),('buy','fomo',0,4,26,2200,'想加仓又按住自己的手'),
    ('loss','loss',0,3.4,26,2200,'被套后鼓脸攥拳装镇定'),('liquidation','loss',1.7,4,26,2200,'嘴硬后呼气松肩'),
    ('sell','loss',2.8,4,26,2200,'放松双手收好心情'),('blink','wave',.65,1.15,20,1600,'闭眼再睁眼'),
    ('sleep','wave',1.1,1.5,32,2600,'闭眼休息的小幅动作')]:
    save(name,segment(source,start,end,n),ms,False,'generated-video-local-retime',desc,source)

(ROOT/'assets/kurumi-generated.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
sheet=Image.new('RGB',(W*5,H*3),(255,248,252));draw=ImageDraw.Draw(sheet)
for i,(name,frame) in enumerate(contact):
    tile=Image.new('RGBA',(W,H),(255,248,252,255));tile.alpha_composite(frame)
    sheet.paste(tile.convert('RGB'),((i%5)*W,(i//5)*H));draw.text(((i%5)*W+10,(i//5)*H+8),name,fill=(92,50,73))
sheet.save(ROOT/'output/kurumi-gif-contact.jpg',quality=92)
print(json.dumps({'animations':len(contact),'bytes':sum(a['bytes'] for a in manifest['animations'].values()),'sourceRuns':runs,'crop':[x0,y0,x1,y1],'scale':scale}))
