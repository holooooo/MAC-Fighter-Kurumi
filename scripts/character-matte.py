"""Local greenscreen matting for flat illustrated characters (Pillow + NumPy only).

Public, frozen API: key(image: PIL.Image.Image) -> PIL.Image.Image (straight RGBA).
No I/O, rescaling, global channel desaturation, SciPy, or model downloads in key().

The inverse problem needs a nearby opaque foreground of the same color. True green
artwork, isolated fully translucent wisps, changing color within a blurred edge,
heavy codec ringing, and wide shadows cannot be uniquely recovered from one plate.
Existing meaningful transparency is returned unchanged; no-screen images likewise.
The arithmetic matches encoded RGB composites, not physically linear-light ones.
Opacity below .025 is discarded as screen noise; no temporal video stabilization.
Edge colors are local approximations and dark outlines may thin on light plates.
Vector residual denoising trades off actual edge texture against green codec spill.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

__all__ = ["key"]


def _screen(rgb):
    h, w = rgb.shape[:2]
    n = max(1, min(h, w) // 32)
    border = np.concatenate((rgb[:n].reshape(-1, 3), rgb[-n:].reshape(-1, 3),
                             rgb[:, :n].reshape(-1, 3), rgb[:, -n:].reshape(-1, 3)))
    # Cyan (including cartoon breath) is not a green screen. Require separation
    # from BOTH red and blue, plus substantial border support.
    green = ((border[:, 1] - border[:, 0] > .10) &
             (border[:, 1] - border[:, 2] > .075) & (border[:, 1] > .40))
    if np.mean(green) < .45:
        return None
    b = np.median(border[green], axis=0)
    # Per-image spatial screen estimate: robust tile medians tolerate JPEG blocks
    # and video letterbox/background gradients without estimating F from screen.
    tile = 48
    rows, cols = (h + tile - 1) // tile, (w + tile - 1) // tile
    field = np.empty((rows, cols, 3), np.float32)
    for y in range(rows):
        for x in range(cols):
            p = rgb[y*tile:min((y+1)*tile,h), x*tile:min((x+1)*tile,w)].reshape(-1,3)
            m = ((p[:,0] <= b[0] + .10) & (p[:,1] >= b[1] - .18) &
                 (p[:,1] - np.maximum(p[:,0],p[:,2]) > .075))
            field[y,x] = np.median(p[m],axis=0) if np.count_nonzero(m) >= 24 else b
    channels = [np.asarray(Image.fromarray(field[:,:,c], mode="F").resize((w,h), Image.Resampling.BILINEAR)) for c in range(3)]
    return np.stack(channels,axis=2)


def _nearest_opaque(mask, radius=18):
    """Bounded jump-flood nearest seed, with Euclidean distance acceptance.

    Extra unit passes refine the approximate Voronoi map. A source outside the
    explicit radius is NEVER used (avoids borrowing skin across a hair gap).
    """
    h,w = mask.shape
    yy,xx = np.indices((h,w),dtype=np.int32)
    sy = np.where(mask,yy,-10000)
    sx = np.where(mask,xx,-10000)
    best = np.where(mask,0,np.iinfo(np.int32).max).astype(np.int32)
    for step in (8,4,2,1,1,1):
        # Read each pass from a stable previous generation, not directional order.
        old_y,old_x = sy.copy(),sx.copy()
        for dy,dx in ((-step,-step),(-step,0),(-step,step),(0,-step),(0,step),(step,-step),(step,0),(step,step)):
            ya,yb = max(0,-dy),min(h,h-dy)
            xa,xb = max(0,-dx),min(w,w-dx)
            cy,cx = old_y[ya+dy:yb+dy,xa+dx:xb+dx],old_x[ya+dy:yb+dy,xa+dx:xb+dx]
            d = (cy-yy[ya:yb,xa:xb])**2 + (cx-xx[ya:yb,xa:xb])**2
            take = (cy >= 0) & (d < best[ya:yb,xa:xb]) & (d <= radius*radius)
            best[ya:yb,xa:xb][take] = d[take]
            sy[ya:yb,xa:xb][take] = cy[take]
            sx[ya:yb,xa:xb][take] = cx[take]
    return np.maximum(sy,0),np.maximum(sx,0),best <= radius*radius


def key(image: Image.Image) -> Image.Image:
    """Return same-size straight RGBA with local alpha and green unmixing.

    Fully opaque non-green core RGB is copied byte-for-byte. Preserve existing
    meaningful alpha and no-screen/cyan-background assets byte-for-byte as RGBA.
    """
    rgba = np.asarray(image.convert("RGBA"))
    if np.any(rgba[:,:,3] < 255):
        return image.convert("RGBA").copy()
    rgb = rgba[:,:,:3].astype(np.float32)/255.0
    background = _screen(rgb)
    if background is None:
        return image.convert("RGBA").copy()
    green = rgb[:,:,1] - np.maximum(rgb[:,:,0],rgb[:,:,2])
    # Trusted foreground, not alpha estimated by a green threshold. The threshold
    # only supplies opaque color samples for the inverse compositing equation.
    nongreen = green <= 2.0/255.0
    # Erode the seed region, not the matte: high-alpha pink/white mixtures can
    # already be non-green. Treating every such pixel as opaque loses .75/.9.
    from PIL import ImageFilter
    opaque = np.asarray(Image.fromarray(nongreen.astype(np.uint8)*255).filter(ImageFilter.MinFilter(7))) > 0
    # Opaque cartoon contours are thin local dark minima, not eroded interiors.
    # Require a local G minimum: a .9 dark-color mixture next to its true core
    # must NOT become an opaque seed simply because it is dark/non-green.
    min_g = np.asarray(Image.fromarray(rgba[:,:,1]).filter(ImageFilter.MinFilter(7))).astype(np.float32)/255
    opaque |= nongreen & (np.max(rgb,axis=2)<.65) & (rgb[:,:,1] <= min_g+1/255)
    if not np.any(opaque):
        return image.convert("RGBA").copy()
    sy,sx,near = _nearest_opaque(opaque)
    foreground = rgb[sy,sx]
    v = foreground-background
    delta = rgb-background
    denom = np.sum(v*v,axis=2)
    alpha = np.sum(delta*v,axis=2)/np.maximum(denom,1e-8)
    residual = np.sqrt(np.sum((delta-alpha[:,:,None]*v)**2,axis=2))
    # Reject screen/noise and foreground matches inconsistent with local model.
    screen_distance = np.sqrt(np.sum(delta*delta,axis=2))
    valid = near & (screen_distance > 3.0/255.0) & (residual < .13)
    alpha = np.where(valid,np.clip(alpha,0,1),0)
    # Below 2.5% the screen's codec/texture uncertainty dominates the signal.
    # Deliberate tradeoff: discard that faint opacity rather than keep a halo.
    alpha[alpha < .025] = 0
    alpha[opaque] = 1
    # JPEG/video chroma subsampling moves colors OFF the B--F mixing line.
    # Orthogonal residual cannot be explained by alpha. Denoise that residual
    # only on the uncertain edge before inverse compositing; otherwise division
    # by a tiny alpha amplifies chroma ringing into a saturated green fringe.
    # This is a local RGB-vector model, not clamping/desaturating green globally.
    projected = background + alpha[:,:,None]*v
    keep_detail = np.clip((alpha-.98)/.02,0,1)[:,:,None]
    clean = projected + keep_detail*(rgb-projected)
    out_rgb = (clean-(1-alpha[:,:,None])*background)/np.maximum(alpha[:,:,None],1e-6)
    out_rgb[opaque] = rgb[opaque]
    out_rgb[alpha <= 0] = 0
    out = np.empty_like(rgba)
    out[:,:,:3] = np.rint(np.clip(out_rgb,0,1)*255).astype(np.uint8)
    out[:,:,3] = np.rint(np.clip(alpha,0,1)*255).astype(np.uint8)
    return Image.fromarray(out,"RGBA")
