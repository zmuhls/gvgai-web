#!/usr/bin/env python3
"""Fine-tune a small model on arcade play traces with Unsloth + QLoRA.

Consumes the chat-messages JSONL written by prepare-finetune-data.js, trains a
LoRA adapter on a CUDA GPU (built for the Legion, 24 GB VRAM), exports a GGUF
for Ollama, and appends an entry to the fine-tune model registry that the Node
catalog merges at runtime.

Progress protocol: one JSON object per stdout line ({"stage": ...}); the Node
orchestrator (lib/finetune-pipeline.js) parses these and ignores non-JSON
lines. Anything human-readable goes to stderr.

--dry-run simulates the full stage sequence without torch/unsloth installed
(module-top imports are stdlib only, heavy imports live inside run_real) so the
pipeline is testable on machines without a GPU.

Real usage (Legion):
  python3 scripts/finetune.py --data data/finetune/game-0-train.jsonl \
    --game-id 0 --game-name aliens --run-id manual-1 \
    --registry data/finetune-models.json --output-dir models
"""

import argparse
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

LAST_STAGE = {"stage": "start"}


def emit(obj):
    LAST_STAGE["stage"] = obj.get("stage", LAST_STAGE["stage"])
    print(json.dumps(obj), flush=True)


def slugify(name):
    slug = re.sub(r"[^a-z0-9._-]+", "-", (name or "game").lower()).strip("-")
    return slug or "game"


def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load_pairs(jsonl_path):
    pairs = []
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if isinstance(row.get("messages"), list) and row["messages"]:
                pairs.append(row["messages"])
    return pairs


def append_registry(registry_path, entry):
    registry_path = Path(registry_path)
    data = {"models": [], "updatedAt": None}
    if registry_path.exists():
        try:
            loaded = json.loads(registry_path.read_text(encoding="utf-8"))
            if isinstance(loaded, list):  # tolerate a legacy bare-array file
                data["models"] = loaded
            elif isinstance(loaded, dict) and isinstance(loaded.get("models"), list):
                data = loaded
        except (json.JSONDecodeError, OSError):
            pass  # corrupt registry: start fresh rather than crash the run
    data["models"].append(entry)
    data["updatedAt"] = iso_now()

    registry_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=str(registry_path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, str(registry_path))
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def build_entry(args, model_id, pair_count, model_path=None, gguf_path=None, dry_run=False):
    base_tail = args.base_model.split("/")[-1]
    entry = {
        "id": model_id,
        "name": f"{base_tail} FT · {args.game_name}",
        "baseModel": args.base_model,
        "provider": "ollama-local",
        "gameId": args.game_id,
        "gameName": args.game_name,
        "trainedOnPlays": args.trained_on_plays,
        "trainedAt": iso_now(),
        "modelPath": model_path,
        "ggufPath": gguf_path,
        "description": f"Fine-tuned on {args.trained_on_plays} human plays of {args.game_name}"
                       f" ({pair_count} examples)",
        "runId": args.run_id,
    }
    if dry_run:
        entry["dryRun"] = True
    return entry


def run_dry(args, model_id):
    emit({"stage": "load_data"})
    pairs = load_pairs(args.data)  # really read it: validates the prep output
    emit({"stage": "load_data", "exampleCount": len(pairs)})
    time.sleep(0.05)

    emit({"stage": "load_model", "baseModel": args.base_model, "dryRun": True})
    time.sleep(0.1)

    total_steps = 10
    emit({"stage": "train_begin", "totalSteps": total_steps, "epochs": args.epochs})
    loss = 2.4
    for step in range(1, total_steps + 1):
        loss = round(loss * 0.82, 4)
        emit({"stage": "train_step", "step": step, "totalSteps": total_steps,
              "epoch": round(step / total_steps * args.epochs, 2),
              "loss": loss, "lr": args.learning_rate})
        time.sleep(0.05)
    emit({"stage": "train_complete", "trainSeconds": 0.5})

    emit({"stage": "export_gguf", "dryRun": True})
    entry = build_entry(args, model_id, len(pairs), dry_run=True)
    append_registry(args.registry, entry)
    emit({"stage": "registry_written", "modelId": model_id, "registry": str(args.registry)})

    emit({"stage": "done", "modelId": model_id, "modelPath": None, "ggufPath": None,
          "trainedOnPlays": args.trained_on_plays, "trainSeconds": 0.5, "dryRun": True})


def run_real(args, model_id):
    emit({"stage": "load_data"})
    pairs = load_pairs(args.data)
    emit({"stage": "load_data", "exampleCount": len(pairs)})
    if len(pairs) < 10:
        print(f"[finetune] WARNING: only {len(pairs)} examples; results will be weak",
              file=sys.stderr)

    import inspect

    import torch
    from unsloth import FastLanguageModel
    from unsloth.chat_templates import get_chat_template, train_on_responses_only
    from datasets import Dataset
    from transformers import TrainerCallback
    from trl import SFTConfig, SFTTrainer

    if not torch.cuda.is_available():
        emit({"stage": "error", "errorStage": "load_model",
              "message": "CUDA not available — this script trains on the Legion GPU, "
                         "use --dry-run elsewhere"})
        sys.exit(1)
    props = torch.cuda.get_device_properties(0)
    emit({"stage": "gpu_check", "device": props.name,
          "vramGb": round(props.total_memory / 1024 ** 3, 1)})

    emit({"stage": "load_model", "baseModel": args.base_model})
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base_model,
        max_seq_length=args.max_seq_length,
        load_in_4bit=True,
        dtype=None,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        lora_alpha=16,
        lora_dropout=0,
        bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth",
        random_state=args.seed,
    )

    tokenizer = get_chat_template(tokenizer, chat_template="gemma-3")

    def render(messages):
        text = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=False)
        # Unsloth re-adds <bos> at tokenization time; a double BOS degrades Gemma.
        return text.removeprefix("<bos>")

    def merge_system(messages):
        # Gemma templates that reject a system role: fold it into the first user turn.
        if messages and messages[0]["role"] == "system":
            system, rest = messages[0], messages[1:]
            if rest and rest[0]["role"] == "user":
                rest = [{"role": "user",
                         "content": system["content"] + "\n\n" + rest[0]["content"]},
                        *rest[1:]]
            return rest
        return messages

    try:
        render(pairs[0])
        rendered = [render(m) for m in pairs]
    except Exception:
        rendered = [render(merge_system(m)) for m in pairs]
    dataset = Dataset.from_list([{"text": t} for t in rendered])

    class ProgressCallback(TrainerCallback):
        def on_log(self, targs, state, control, logs=None, **kwargs):
            if logs and "loss" in logs:
                emit({"stage": "train_step", "step": state.global_step,
                      "totalSteps": state.max_steps, "epoch": logs.get("epoch"),
                      "loss": logs["loss"], "lr": logs.get("learning_rate")})

    out_dir = Path(args.output_dir) / model_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # TRL renamed max_seq_length -> max_length on SFTConfig across releases.
    sft_params = inspect.signature(SFTConfig.__init__).parameters
    seq_key = "max_seq_length" if "max_seq_length" in sft_params else "max_length"
    config_kwargs = {
        "output_dir": str(out_dir / "checkpoints"),
        "per_device_train_batch_size": args.batch_size,
        "gradient_accumulation_steps": args.grad_accum,
        "warmup_steps": 10,
        "num_train_epochs": args.epochs,
        "learning_rate": args.learning_rate,
        "logging_steps": 1,
        "optim": "adamw_8bit",
        "weight_decay": 0.01,
        "lr_scheduler_type": "linear",
        "seed": args.seed,
        "report_to": "none",
        "dataset_text_field": "text",
        seq_key: args.max_seq_length,
    }
    if args.max_steps > 0:
        config_kwargs["max_steps"] = args.max_steps

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        args=SFTConfig(**config_kwargs),
        callbacks=[ProgressCallback()],
    )
    # The assistant turn is one action token vs a multi-KB prompt: without
    # response masking the loss is almost entirely prompt-modeling noise.
    trainer = train_on_responses_only(
        trainer,
        instruction_part="<start_of_turn>user\n",
        response_part="<start_of_turn>model\n",
    )

    steps_per_epoch = max(1, len(dataset) // (args.batch_size * args.grad_accum))
    emit({"stage": "train_begin", "epochs": args.epochs,
          "totalSteps": args.max_steps or int(steps_per_epoch * args.epochs),
          "examples": len(dataset)})
    started = time.time()
    trainer.train()
    train_seconds = round(time.time() - started, 1)
    emit({"stage": "train_complete", "trainSeconds": train_seconds})

    lora_dir = out_dir / "lora"
    model.save_pretrained(str(lora_dir))
    tokenizer.save_pretrained(str(lora_dir))

    emit({"stage": "export_gguf", "quant": args.quant})
    model.save_pretrained_gguf(str(out_dir), tokenizer, quantization_method=args.quant)
    # Unsloth's GGUF filename convention has shifted between releases: glob,
    # preferring a file that names the requested quant.
    ggufs = sorted(out_dir.glob("*.gguf"), key=lambda p: p.stat().st_mtime)
    preferred = [p for p in ggufs if args.quant.replace("_", "").lower()
                 in p.name.replace("_", "").replace("-", "").lower()]
    gguf_path = str((preferred or ggufs)[-1].resolve()) if ggufs else None
    if not gguf_path:
        emit({"stage": "error", "errorStage": "export_gguf",
              "message": f"no .gguf produced under {out_dir}"})
        sys.exit(1)

    entry = build_entry(args, model_id, len(pairs),
                        model_path=str(lora_dir.resolve()), gguf_path=gguf_path)
    append_registry(args.registry, entry)
    emit({"stage": "registry_written", "modelId": model_id, "registry": str(args.registry)})

    emit({"stage": "done", "modelId": model_id, "modelPath": str(lora_dir.resolve()),
          "ggufPath": gguf_path, "trainedOnPlays": args.trained_on_plays,
          "trainSeconds": train_seconds})


def parse_args():
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Fine-tune via Unsloth + QLoRA")
    parser.add_argument("--data", required=True, help="training JSONL (chat-messages rows)")
    parser.add_argument("--game-id", type=int, required=True)
    parser.add_argument("--game-name", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--registry", default=str(here.parent / "data" / "finetune-models.json"))
    parser.add_argument("--output-dir", default=str(here.parent / "models"),
                        help="parent dir; the model lands in <output-dir>/<model-id>/")
    parser.add_argument("--base-model", default="unsloth/gemma-3-4b-it")
    parser.add_argument("--trained-on-plays", type=int, default=0)
    parser.add_argument("--epochs", type=float, default=2)
    parser.add_argument("--max-steps", type=int, default=0, help="0 = use epochs")
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--max-seq-length", type=int, default=4096)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--quant", default="q4_k_m")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    model_id = f"gvgai-{slugify(args.game_name)}-ft-{time.strftime('%Y%m%d%H%M', time.gmtime())}"
    emit({"stage": "start", "runId": args.run_id, "gameId": args.game_id,
          "modelId": model_id, "baseModel": args.base_model, "dryRun": args.dry_run})
    try:
        if args.dry_run:
            run_dry(args, model_id)
        else:
            run_real(args, model_id)
    except SystemExit:
        raise
    except BaseException as err:  # noqa: BLE001 — last-resort protocol emitter
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit({"stage": "error", "errorStage": LAST_STAGE["stage"],
              "message": f"{type(err).__name__}: {err}"})
        sys.exit(1)


if __name__ == "__main__":
    main()
