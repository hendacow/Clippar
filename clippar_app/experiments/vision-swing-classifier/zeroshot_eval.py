"""
Zero-shot swing-phase separability test on real Clippar footage.
Uses an OLD/SMALL CLIP (ViT-B-32, 2021) as a conservative proxy: if this
separates the classes, the newer on-device models (FastVLM / MobileCLIP2)
will do at least as well. No training. Runs on CPU.
"""
import glob, os, sys
import torch, open_clip
from PIL import Image

MODEL, PRETRAIN = "ViT-B-32", "openai"
model, _, preprocess = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAIN)
tokenizer = open_clip.get_tokenizer(MODEL)
model.eval()

# Class prompts. Each class has a few paraphrases; we average their embeddings.
CLASSES = {
    "ADDRESS (standing over ball, not swinging)": [
        "a golfer standing still at address over the ball before the swing",
        "a golfer bent over the ball with the club resting on the ground, not moving",
    ],
    "SWING IN PROGRESS (backswing/downswing)": [
        "a golfer mid golf swing with the club raised up in the air",
        "a golfer swinging a golf club, club high above the shoulders",
    ],
    "FINISH POSE (after hitting)": [
        "a golfer in the follow through finish pose facing the target after hitting",
        "a golfer holding the finish of a golf swing, body rotated toward the target",
    ],
    "PUTT/CHIP (short stroke on green)": [
        "a golfer making a short putting stroke on the green",
        "a golfer chipping the ball with a short controlled stroke",
    ],
    "NO SHOT (empty course / no golfer swinging)": [
        "an empty golf course with no one swinging",
        "a golf course fairway with no golfer in swing",
    ],
}

names = list(CLASSES.keys())
with torch.no_grad():
    text_feats = []
    for n in names:
        toks = tokenizer(CLASSES[n])
        tf = model.encode_text(toks)
        tf = tf / tf.norm(dim=-1, keepdim=True)
        text_feats.append(tf.mean(0, keepdim=True))
    text_feats = torch.cat(text_feats)
    text_feats = text_feats / text_feats.norm(dim=-1, keepdim=True)

frames = sorted(glob.glob(sys.argv[1] + "/*.jpg"))
print(f"model={MODEL}/{PRETRAIN}  frames={len(frames)}\n")
for fp in frames:
    img = preprocess(Image.open(fp).convert("RGB")).unsqueeze(0)
    with torch.no_grad():
        f = model.encode_image(img)
        f = f / f.norm(dim=-1, keepdim=True)
        probs = (100.0 * f @ text_feats.T).softmax(-1)[0]
    top = int(probs.argmax())
    bars = "  ".join(f"{names[i].split(' ')[0]}:{probs[i]*100:4.1f}" for i in range(len(names)))
    print(f"{os.path.basename(fp):10s} -> {names[top].split(' (')[0]:34s} | {bars}")
