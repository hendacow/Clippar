"""Pre-compute normalized text embeddings for the fixed class prompts from
MobileCLIP2-S2, so the on-device path needs only the image encoder."""
import json, torch, open_clip

MODEL, PRETRAIN = "MobileCLIP2-S2", "dfndr2b"
model, _, _ = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAIN)
tok = open_clip.get_tokenizer(MODEL)
model.eval()

CLASSES = {
    "full_swing": [
        "a golfer mid golf swing with the club raised up in the air",
        "a golfer swinging a golf club, club high above the shoulders",
        "a golfer in the follow through finish pose facing the target after hitting",
    ],
    "address": [
        "a golfer standing still at address over the ball before the swing",
        "a golfer bent over the ball with the club resting on the ground, not moving",
    ],
    "putt_chip": [
        "a golfer making a short putting stroke on the green",
        "a golfer chipping the ball with a short controlled stroke",
    ],
    "no_shot": [
        "an empty golf course with no one swinging",
        "a golf course fairway with no golfer in swing",
    ],
}

out = {"model": f"{MODEL}/{PRETRAIN}", "dim": None, "classes": {}}
with torch.no_grad():
    for name, prompts in CLASSES.items():
        t = model.encode_text(tok(prompts))
        t = t / t.norm(dim=-1, keepdim=True)
        v = t.mean(0)
        v = v / v.norm()
        out["classes"][name] = [round(float(x), 6) for x in v.tolist()]
        out["dim"] = len(v)
print("dim", out["dim"])
json.dump(out, open("class_text_embeddings.json", "w"), indent=0)
print("wrote class_text_embeddings.json")
