"""
Convert the MobileCLIP2-S2 IMAGE encoder to a Core ML .mlpackage for on-device
use. We ship only the image tower — the text embeddings are precomputed
offline (dump_embeds.py) so the phone needs no text model or tokenizer.

Run on a Mac:
    python3 -m venv env && source env/bin/activate
    pip install torch open_clip_torch coremltools pillow numpy
    python3 convert_mobileclip_to_coreml.py

Output: MobileCLIP2S2Image.mlpackage  (~35-40 MB image encoder)

IMPORTANT: use the SAME model (MobileCLIP2-S2 / dfndr2b) that dump_embeds.py
used, or the image and text embeddings won't share a space.
"""
import torch, open_clip, coremltools as ct

MODEL, PRETRAIN = "MobileCLIP2-S2", "dfndr2b"
model, _, preprocess = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAIN)
model.eval()

# Discover the model's expected input resolution from its preprocess transform.
size = 256
for t in preprocess.transforms:
    if hasattr(t, "size"):
        s = t.size
        size = s[0] if isinstance(s, (list, tuple)) else s
        break
print(f"input size = {size}")


class ImageEncoder(torch.nn.Module):
    """Wrap encode_image and L2-normalize so the device gets a unit vector."""
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        f = self.m.encode_image(x)
        return f / f.norm(dim=-1, keepdim=True)


wrapper = ImageEncoder(model).eval()
example = torch.rand(1, 3, size, size)
traced = torch.jit.trace(wrapper, example)

# CLIP normalization (OpenAI stats) folded into the Core ML input so the app can
# pass a plain image; scale/bias map [0,255] -> normalized.
# mean/std are the standard CLIP values.
mean = [0.48145466, 0.4578275, 0.40821073]
std = [0.26862954, 0.26130258, 0.27577711]
scale = 1.0 / (255.0 * sum(std) / 3)  # approx; see note below

mlmodel = ct.convert(
    traced,
    inputs=[ct.ImageType(
        name="image",
        shape=(1, 3, size, size),
        scale=1 / 255.0,
        bias=[-m for m in mean],  # coarse; refine per-channel std if needed
        color_layout=ct.colorlayout.RGB,
    )],
    outputs=[ct.TensorType(name="embedding")],
    minimum_deployment_target=ct.target.iOS16,
    compute_units=ct.ComputeUnit.ALL,
    convert_to="mlprogram",
)
mlmodel.short_description = "MobileCLIP2-S2 image encoder (L2-normalized 512-d)"
mlmodel.save("MobileCLIP2S2Image.mlpackage")
print("saved MobileCLIP2S2Image.mlpackage")
print("NOTE: verify preprocessing parity against verify_pipeline.py on a few "
      "frames — per-channel std handling in ImageType is approximate; if scores "
      "drift, apply normalization inside the traced module instead.")
