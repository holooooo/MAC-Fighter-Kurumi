"""Run with bundled Python; no paid services, SciPy, or source asset mutations.

python tests/character-matte-test.py [--qa]
Synthetic truth is generated independently from key's inverse equations.
QA keeps original pixels at 1:1 (no downsampling), plus 3x nearest edge crops.
"""
from pathlib import Path
import importlib.util
import argparse
import io
import subprocess
import time
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("character_matte", ROOT/"scripts/character-matte.py")
matte = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matte)


def synthetic():
    alphas = [.1,.25,.5,.75,.9]
    # Deliberately unequal R/G/B, not only neutral samples which hide bad keys.
    colors = {"white":(247,242,254),"pink":(225,125,171),
              "skin":(244,204,176),"dark":(27,16,41)}
    backgrounds = [(19,242,150),(7,219,39)]
    results=[]
    for bg in backgrounds:
        b=np.array(bg,dtype=float)
        for name,color in colors.items():
            f=np.array(color,dtype=float)
            # Each edge band is 3 px wide and directly borders the opaque core;
            # separate independent rows prevent neighboring different alphas
            # being mistaken for a wider homogeneous fully opaque core.
            h,w=220,140
            truth=np.zeros((h,w),float)
            truth[20:200,35:105]=1
            for i,a in enumerate(alphas):
                truth[27+i*34:47+i*34,32:35]=a
            rgb=np.rint(truth[:,:,None]*f+(1-truth[:,:,None])*b).astype(np.uint8)
            result=np.asarray(matte.key(Image.fromarray(rgb)))
            got_a=result[:,:,3]/255.0
            got_f=result[:,:,:3].astype(float)
            for i,a in enumerate(alphas):
                sl=(slice(30+i*34,44+i*34),slice(32,35))
                ae=float(np.max(np.abs(got_a[sl]-a)))
                fe=float(np.mean(np.abs(got_f[sl]-f)))
                errors=[]
                for dest in ((255,255,255),(18,20,27),(90,110,160)):
                    dest=np.array(dest)
                    composite=got_a[sl][:,:,None]*got_f[sl]+(1-got_a[sl][:,:,None])*dest
                    expected=a*f+(1-a)*dest
                    errors.append(float(np.max(np.abs(composite-expected))))
                ce=max(errors)
                results.append((name,a,ae,fe,ce))
                assert ae < .025, (bg,name,a,"alpha error",ae)
                assert ce < 5.0, (bg,name,a,"composite channel error",ce)
            interior=result[40:180,50:90]
            assert np.all(interior[:,:,3]==255),(bg,name,"opaque loss")
            assert np.all(interior[:,:,:3]==np.array(color)),(bg,name,"opaque recolored")
            assert np.count_nonzero(result[:15,:,3])==0,"screen remains"
    # Independent textured plate, non-neutral subject, and channel-wise noise.
    # This tests B estimation rather than perfectly uniform-only green plates.
    rng=np.random.default_rng(734)
    h,w=240,240; yy,xx=np.indices((h,w));
    b=np.empty((h,w,3),float)
    b[:,:,0]=17+4*xx/w; b[:,:,1]=235+7*yy/h; b[:,:,2]=133+5*xx/w
    f=np.array((219,113,164),float)
    truth=np.zeros((h,w),float); truth[35:205,80:180]=1
    for i,a in enumerate(alphas): truth[43+i*30:61+i*30,77:80]=a
    source=np.clip(np.rint(truth[:,:,None]*f+(1-truth[:,:,None])*b+rng.normal(0,.65,(h,w,3))),0,255).astype(np.uint8)
    out=np.asarray(matte.key(Image.fromarray(source))); got=out[:,:,3]/255
    noise_ae=[]; noise_ce=[]
    for i,a in enumerate(alphas):
        sl=(slice(46+i*30,58+i*30),slice(77,80))
        ae=float(np.max(np.abs(got[sl]-a))); noise_ae.append(ae)
        c=out[sl][:,:,:3]*got[sl][:,:,None]+(1-got[sl][:,:,None])*np.array((255,255,255))
        ce=float(np.max(np.abs(c-(a*f+(1-a)*255)))); noise_ce.append(ce)
    assert max(noise_ae)<.025,("textured plate alpha",max(noise_ae))
    assert max(noise_ce)<5,("textured plate composite",max(noise_ce))
    print("PASS textured/noisy plate: max alpha error=%.6f; max white composite channel error=%.3f/255" % (max(noise_ae),max(noise_ce)))
    cyan=Image.new("RGB",(96,96),(80,235,247))
    ImageDraw.Draw(cyan).ellipse((20,20,75,75),fill=(200,250,255))
    assert np.array_equal(np.asarray(matte.key(cyan)),np.asarray(cyan.convert("RGBA")))
    transparent=cyan.convert("RGBA"); transparent.putalpha(127)
    assert np.array_equal(np.asarray(matte.key(transparent)),np.asarray(transparent))
    print("PASS known composites:",len(results),"alpha/color cases; two screens; white/pink/skin/dark")
    print("max alpha error=%.6f; max compositing channel error=%.3f/255; mean straight RGB MAE=%.3f/255" %
          (max(r[2] for r in results),max(r[4] for r in results),np.mean([r[3] for r in results])))
    print("PASS exact opaque RGB/alpha, cyan no-screen identity, meaningful existing alpha identity")


def checker(size):
    y,x=np.indices((size[1],size[0])); a=((x//16+y//16)%2)*55+185
    return Image.fromarray(np.repeat(a[:,:,None],3,axis=2).astype(np.uint8)).convert("RGBA")


def qa_image(source,tag,crop):
    start=time.perf_counter(); result=matte.key(source); elapsed=time.perf_counter()-start
    backgrounds=[Image.new("RGBA",source.size,(250,247,244,255)),
                 Image.new("RGBA",source.size,(18,20,27,255)),checker(source.size)]
    views=[source.convert("RGB")]+[Image.alpha_composite(b,result).convert("RGB") for b in backgrounds]
    labels=["ORIGINAL","KEY ON LIGHT","KEY ON DARK","KEY ON CHECKER"]
    w,h=source.size
    sheet=Image.new("RGB",(w*4,h+32),(36,36,40)); draw=ImageDraw.Draw(sheet)
    for i,(view,label) in enumerate(zip(views,labels)):
        sheet.paste(view,(i*w,32)); draw.text((i*w+10,9),label,fill="white")
    sheet.save(ROOT/f"output/matte-qa-{tag}-sourcezoom.png")
    x0,y0,x1,y1=crop; cw,ch=(x1-x0)*3,(y1-y0)*3
    sheet=Image.new("RGB",(cw*4,ch+32),(36,36,40)); draw=ImageDraw.Draw(sheet)
    for i,(view,label) in enumerate(zip(views,labels)):
        sheet.paste(view.crop(crop).resize((cw,ch),Image.Resampling.NEAREST),(cw*i,32))
        draw.text((cw*i+10,9),label+" / 3x nearest",fill="white")
    sheet.save(ROOT/f"output/matte-qa-{tag}-edgezoom.png")
    result.save(ROOT/f"output/matte-qa-{tag}-rgba.png")
    a=np.array(result)[:,:,3]
    print(f"{tag}: {w}x{h}, key {elapsed:.3f}s, alpha0={np.mean(a==0):.4f}, partial={np.mean((a>0)&(a<255)):.4f}, opaque={np.mean(a==255):.4f}")
    print(f"QA crop {crop}; no ground truth: actual alpha accuracy unmeasured")


def actual_qa():
    source=Image.open(ROOT/"output/kurumi-generated-reference/AA4vCOxNi9Wh_dGLJr7B8rb-1-nanobanana_3aca59b6.jpg").convert("RGB")
    qa_image(source,"canonical",(255,160,375,400))
    videos=sorted((ROOT/"output/kurumi-correct-video/wave").glob("*.mp4"))
    assert videos,"missing original wave video"
    data=subprocess.check_output(["ffmpeg","-v","error","-ss","1.2","-i",str(videos[0]),"-frames:v","1","-f","image2pipe","-vcodec","png","-threads","1","-"])
    source=Image.open(io.BytesIO(data)).convert("RGB")
    qa_image(source,"wave",(135,195,220,335))


if __name__=="__main__":
    parser=argparse.ArgumentParser(); parser.add_argument("--qa",action="store_true"); args=parser.parse_args()
    synthetic()
    if args.qa: actual_qa()
