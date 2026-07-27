"""End-to-end check of the SHIPPING path: image encoder -> cosine vs BAKED
text embeddings -> per-clip max-pool decision. Mirrors what Swift will do."""
import json, glob, os, sys
import torch, open_clip
from PIL import Image

emb = json.load(open("class_text_embeddings.json"))
names = list(emb["classes"].keys())
T = torch.tensor([emb["classes"][n] for n in names])  # [C,512], already normalized

model, _, preprocess = open_clip.create_model_and_transforms("MobileCLIP2-S2", pretrained="dfndr2b")
model.eval()

def frame_scores(fp):
    img = preprocess(Image.open(fp).convert("RGB")).unsqueeze(0)
    with torch.no_grad():
        f = model.encode_image(img)
        f = f / f.norm(dim=-1, keepdim=True)
        sims = (f @ T.T)[0]                 # cosine similarity to each class
        probs = (100.0 * sims).softmax(-1)  # same temp as eval
    return {names[i]: float(probs[i]) for i in range(len(names))}

def decide(frames):
    # Clip-level max-pool: strongest evidence for each class across sampled frames.
    pooled = {n: max(frame_scores(fp)[n] for fp in frames) for n in names}
    # Decision rule (tunable thresholds):
    if pooled["full_swing"] >= 0.40:
        label = "FULL_SWING"
    elif pooled["no_shot"] >= 0.50 and pooled["full_swing"] < 0.25:
        label = "NO_SHOT"
    elif pooled["putt_chip"] >= pooled["address"]:
        label = "PUTT_CHIP"
    else:
        label = "ADDRESS_ONLY"
    return label, pooled

frames = sorted(glob.glob(sys.argv[1] + "/*.jpg"))
label, pooled = decide(frames)
print(f"clip={os.path.basename(os.path.dirname(sys.argv[1]+'/'))}  n={len(frames)}")
print("pooled:", {k: round(v, 3) for k, v in pooled.items()})
print("DECISION:", label)
