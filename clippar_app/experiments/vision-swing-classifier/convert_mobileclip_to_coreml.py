"""
Convert the MobileCLIP2 IMAGE encoder to a Core ML .mlpackage for on-device use.
We ship ONLY the image tower — class text embeddings are precomputed offline
(dump_embeds.py) so the phone needs no text model or tokenizer.

======================================================================
KNOWN-GOOD TOOLCHAIN (hard-won — pin these exactly)
======================================================================
coremltools 9.0 + numpy 2.x FAILS on the MobileCLIP/FastViT graph with:
  - "only 0-dimensional arrays can be converted to Python scalars" (aten::Int)
  - "Cannot add const [Var, Var, ...]" (view op, dynamic reshape)
These are toolchain bugs, not model bugs (they also hit plain ViT-B-16).

Use instead:
    python3 -m venv env && source env/bin/activate
    pip install "numpy<2" "torch==2.5.1" "torchvision==0.20.1" \
                "coremltools==8.3" open_clip_torch pillow
    python3 convert_mobileclip_to_coreml.py

======================================================================
TWO NON-OBVIOUS CORRECTNESS POINTS
======================================================================
1. MobileCLIP2 preprocessing normalization is the IDENTITY (mean=0, std=1) —
   the transform is just Resize(256) + CenterCrop(256) + [0,1]. Do NOT bake the
   OpenAI CLIP mean/std; doing so made Core ML disagree with PyTorch by up to
   0.69 in class prob (frames flipped class). With identity norm, Core ML vs
   PyTorch parity is worst 0.06, ZERO argmax flips across the test frames.
2. The .mlpackage input is an ImageType with scale=1/255 (→ [0,1]); no bias.

MODEL CHOICE: MobileCLIP2-S2 (~35M image params, 69MB fp16) — validated, 0
parity flips. MobileCLIP2-S0 also converts (22MB, faster) but showed 2 flips vs
PyTorch on the test frames; it's the lighter production candidate if the size/
speed win is worth the small accuracy hit. int8 quantization of S2 lost too much
(4 flips) — don't. fp16 is already the mlprogram default at iOS16 target.
"""
import torch, open_clip, coremltools as ct

MODEL, PRETRAIN = "MobileCLIP2-S2", "dfndr2b"
model, _, preprocess = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAIN)
model.eval()

size = 256
for t in preprocess.transforms:
    if hasattr(t, "size"):
        s = t.size
        size = s[0] if isinstance(s, (list, tuple)) else s
        break
print("input size", size)


class ImageEncoder(torch.nn.Module):
    """MobileCLIP2 normalize is identity, so the graph just encodes [0,1] and
    L2-normalizes. Core ML ImageType feeds [0,1] via scale=1/255."""
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        f = self.m.encode_image(x)
        return f / f.norm(dim=-1, keepdim=True)


traced = torch.jit.trace(ImageEncoder(model).eval(), torch.rand(1, 3, size, size),
                         check_trace=False)

mlmodel = ct.convert(
    traced,
    inputs=[ct.ImageType(name="image", shape=(1, 3, size, size),
                         scale=1 / 255.0, bias=[0, 0, 0],
                         color_layout=ct.colorlayout.RGB)],
    outputs=[ct.TensorType(name="embedding")],
    minimum_deployment_target=ct.target.iOS16,
    compute_precision=ct.precision.FLOAT16,
    convert_to="mlprogram",
)
mlmodel.short_description = "MobileCLIP2-S2 image encoder, L2-normalized 512-d"
mlmodel.save("MobileCLIP2S2Image.mlpackage")
print("saved MobileCLIP2S2Image.mlpackage")
print("Verify parity with verify_pipeline.py before shipping — Core ML must "
      "match PyTorch to <0.1 prob with 0 argmax flips.")
