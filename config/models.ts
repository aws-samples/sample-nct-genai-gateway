export interface VllmModelConfig {
  /** HuggingFace model ID */
  modelId: string;
  /** K8s serving name — used as Deployment name and NLB service name */
  servingName: string;
  /** Scenario alias — primary LiteLLM alias (e.g. 'coding', 'ocr') */
  alias: string;
  /** EC2 instance type for Karpenter NodePool selection */
  instanceType: string;
  /** Number of GPUs per replica */
  gpuCount: number;
  /** vLLM --tensor-parallel-size (defaults to gpuCount) */
  tensorParallelSize?: number;
  /** Max model context length */
  maxModelLen: number;
  /** vLLM Docker image tag */
  vllmImageTag: string;
  /** Enable vision/multimodal inputs */
  enableVision: boolean;
  /** Enable audio inputs (Phi-4 Multimodal only) */
  enableAudio?: boolean;
  /** 0 = scale-to-zero, 1 = always-on */
  minReplicas: number;
  maxReplicas: number;
  /** Mount EFS model cache at /model-cache */
  efsEnabled: boolean;
  /** Additional LiteLLM aliases beyond the primary alias */
  extraAliases?: string[];
  /** Extra vLLM CLI flags appended after the standard args */
  extraArgs?: string[];
  /** Shell commands to run in an initContainer before vLLM starts */
  initCommands?: string[];
  /** Override liveness probe initialDelaySeconds (default: 180) */
  livenessInitialDelaySecs?: number;
  /** Override liveness probe failureThreshold (default: 5) */
  livenessFailureThreshold?: number;
}

/** Scenario model lineup. Benchmark figures are illustrative — verify against the current model card before relying on them. */
export const VLLM_MODELS: Record<string, VllmModelConfig> = {
  coding: {
    // Qwen3.5-27B: SWE-bench 72.0%, LCB v6 80.7%
    modelId: 'Qwen/Qwen3.5-27B',
    servingName: 'qwen35-27b',
    alias: 'coding',
    instanceType: 'g5.12xlarge',
    gpuCount: 4,
    tensorParallelSize: 4,
    maxModelLen: 32768,
    vllmImageTag: 'latest',
    enableVision: true,
    minReplicas: 0,
    maxReplicas: 3,
    efsEnabled: true,
  },
  video: {
    // Qwen3.5-27B: MMMU 85.0, native video understanding — separate instance for fault isolation
    modelId: 'Qwen/Qwen3.5-27B',
    servingName: 'qwen35-27b-video',
    alias: 'video',
    instanceType: 'g5.12xlarge',
    gpuCount: 4,
    tensorParallelSize: 4,
    maxModelLen: 32768,
    vllmImageTag: 'latest',
    enableVision: true,
    minReplicas: 0,
    maxReplicas: 2,
    efsEnabled: true,
  },
  ocr: {
    // InternVL3-14B: DocVQA 94.1, OCRBench 875 — document/diagram OCR
    modelId: 'OpenGVLab/InternVL3-14B',
    servingName: 'internvl3-14b',
    alias: 'ocr',
    instanceType: 'g5.12xlarge',
    gpuCount: 4,
    tensorParallelSize: 4,
    maxModelLen: 8192,
    vllmImageTag: 'latest',
    enableVision: true,
    minReplicas: 0,
    maxReplicas: 2,
    efsEnabled: true,
  },
  longcontext: {
    // LLaMA 4 Scout 17B-16E: 10M context, MoE 17B active / 109B total params
    // HF gate approved 2026-05-01. g6e.48xlarge: 8x L40S (48GB each = 384GB total)
    // --enforce-eager: disables CUDA graph capture to avoid >20min startup at maxModelLen=131072
    modelId: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    servingName: 'llama4-scout',
    alias: 'longcontext',
    instanceType: 'g6e.48xlarge',
    gpuCount: 8,
    tensorParallelSize: 8,
    maxModelLen: 131072,
    vllmImageTag: 'latest',
    enableVision: true,
    minReplicas: 0,
    maxReplicas: 1,
    efsEnabled: true,
    // I7 fix: 900s grace + 3×60s = 960s total. WarmupMachine timeout raised to 50min (3000s).
    // Previous: 900 + 20×60 = 2100s ≈ 35min matched actual boot time → TIMED_OUT at 25min cap.
    livenessInitialDelaySecs: 2400,
    livenessFailureThreshold: 3,
    extraArgs: ['--enforce-eager', '--safetensors-load-strategy=prefetch'],
  },
  math: {
    // Gemma 4 31B: AIME 2026 89.2%, GPQA 84.3% — math/reasoning
    // extraArgs: max_tokens_per_mm_item=2496 (vision budget) > default max_num_batched_tokens=2048
    modelId: 'google/gemma-4-31b-it',
    servingName: 'gemma4-31b',
    alias: 'math',
    instanceType: 'g6e.12xlarge',
    gpuCount: 4,
    tensorParallelSize: 4,
    maxModelLen: 32768,
    vllmImageTag: 'latest',
    enableVision: false,
    minReplicas: 0,
    maxReplicas: 2,
    efsEnabled: true,
    extraArgs: ['--max-num-batched-tokens', '4096'],
  },
  audio: {
    // Phi-4 Multimodal: unified audio+image+video — meeting transcription
    // initCommands: scipy required by Phi-4 modeling code, not bundled in vllm:latest
    modelId: 'microsoft/Phi-4-multimodal-instruct',
    servingName: 'phi4-multimodal',
    alias: 'audio',
    instanceType: 'g5.xlarge',
    gpuCount: 1,
    maxModelLen: 16384,
    vllmImageTag: 'latest',
    enableVision: true,
    enableAudio: true,
    minReplicas: 0,
    maxReplicas: 2,
    efsEnabled: true,
    initCommands: ['pip install scipy --quiet'],
  },
};

/** Bedrock ON_DEMAND Seoul (NCT compliant) — Fallback + Claude Code CLI compat */
export interface BedrockModelConfig {
  /** LiteLLM alias exposed to clients */
  modelName: string;
  /** Bedrock model ID — Seoul IN_REGION only */
  bedrockModelId: string;
  awsRegion?: string;
}

export const BEDROCK_MODELS: BedrockModelConfig[] = [
  {
    // Claude Code CLI target alias — Sonnet fallback
    modelName: 'claude-3-5-sonnet-20241022',
    bedrockModelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    awsRegion: 'ap-northeast-2',
  },
  {
    // EOL 2026-09-10 — replace with Haiku 3.5 when Seoul IN_REGION available
    modelName: 'claude-3-haiku-20240307',
    bedrockModelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    awsRegion: 'ap-northeast-2',
  },
];

export const DEFAULT_VLLM_IMAGE = 'vllm/vllm-openai';
// v0.10.2 does not support qwen3_5/gemma4/llama4 architectures — use latest
export const DEFAULT_VLLM_TAG = 'latest';
