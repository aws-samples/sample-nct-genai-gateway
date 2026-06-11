# NCT GenAI Gateway

> 🌏 **English**: see [README.en.md](README.en.md). 본 문서(한국어)가 정본입니다.

모든 추론이 한국(Seoul) 리전에서만 발생하도록 강제하는 region-locked LLM Gateway 샘플. 연구원이 **Claude Code CLI**를 그대로 사용하면서 내부적으로는 Bedrock(Claude Sonnet/Haiku) 또는 EKS 위의 6종 오픈소스 vLLM 모델로 라우팅된다.

> **NCT(국가핵심기술)란?** 한국 「산업기술의 유출방지 및 보호에 관한 법률」이 정한 국가핵심기술. 클라우드 이용 시 데이터·접근 권한이 국외로 나가지 않도록 요구된다([근거법](https://www.law.go.kr/법령/산업기술의유출방지및보호에관한법률)). 이 샘플은 그 요건을 AWS Seoul 리전 단일 운영으로 충족하는 아키텍처를 보여준다.

> **Disclaimer — 프로덕션 용도 아님.** 본 저장소는 교육·데모 목적의 샘플 코드이며 **프로덕션 사용을 위한 것이 아닙니다**. 어떠한 보증도 없이 "있는 그대로(as is)" 제공됩니다. 배포 전 반드시 자체 보안·컴플라이언스·운영 요건에 맞춰 검토·강화·테스트하십시오. NCT(국가핵심기술) 관련 기술은 이 아키텍처가 보여주는 *지원 컨트롤(supporting controls)*을 설명한 것으로, 규제 준수에 대한 인증이나 법적 보증이 아닙니다.

---

## 왜 이 repo가 필요한가

**문제.** NCT(국가핵심기술)를 다루는 한국 제조·방산·반도체 고객은 데이터와 접근 권한이 국외로 나가면 안 된다. 그래서 LLM도 **서울(ap-northeast-2) 리전 안에서만** 돌려야 한다. 그런데 서울 in-region으로 즉시 쓸 수 있는 frontier 사양의 매니지드 모델은 사실상 **Amazon Bedrock의 Claude 3.5 Sonnet** 하나뿐이다 (cross-region inference를 쓰면 트래픽이 리전을 벗어나 NCT 요건에 어긋난다).

**그 대가가 얼마인가.** Bedrock 서울에 in-region으로 잡히는 Claude 3.5 Sonnet(`2024-06-20`)은 agentic 코딩 기준 **SWE-bench Verified ≈ 33%** 다. 오늘의 frontier 상한(Claude Opus 4.8 ≈ 88.6%) 대비 **≈ 37% 수준**에 불과하다. 즉 "규정을 지키려고 서울에 갇히는 순간, 코딩 능력의 60% 이상을 포기"하게 된다. (업데이트판 `2024-10-22`를 쓸 수 있어도 ≈ 49% = frontier의 ≈ 55%로, 갭은 여전히 크다.)

**이 repo의 해법 — frontier를 ~82%까지 끌어올리는 hedge.** 가중치가 공개된 open-source 모델을 서울 리전 EKS에 self-host하면, 트래픽이 리전을 벗어나지 않으면서도 훨씬 높은 성능을 낼 수 있다. 이 CDK가 기본 탑재한 `coding` 모델 **Qwen3.5-27B**는 **SWE-bench Verified ≈ 72.4% = frontier의 ≈ 82%** 다 (지식·수학 축은 90% 이상으로 더 근접). in-region Bedrock(≈37%)에서 **두 배 이상**으로 올라간다.

| 서울 in-region 선택지 | SWE-bench Verified | frontier(Opus 4.8=88.6) 대비 |
|----|----|----|
| Bedrock Claude 3.5 Sonnet (`2024-06-20`) — 매니지드 유일 옵션 | ≈ 33% | **≈ 37%** |
| Bedrock Claude 3.5 Sonnet (`2024-10-22`) | ≈ 49% | ≈ 55% |
| **이 CDK의 `coding` = Qwen3.5-27B (self-host)** | **≈ 72.4%** | **≈ 82%** |

**메시지.** *"NCT 때문에 서울에 갇혀 frontier의 37%짜리 모델밖에 못 쓴다"* 는 통념을, 이 **2-command CDK 솔루션**(`cdk deploy --all` → `finalize-deploy.sh`)이 *"frontier 대비 80% 수준을 서울 in-region으로 유지하면서 NCT를 AWS에서 준수한다"* 로 바꾼다. 연구원은 **Claude Code CLI를 그대로** 쓰고, gateway가 내부적으로 Bedrock(서울) 또는 self-host open-source vLLM으로 라우팅한다. frontier 100%는 아니지만 80% 수준이면 대부분의 실무를 커버하며, 무엇보다 **데이터 주권을 깨지 않는다.**

> 수치 근거·해석 주의·더 높은 충실도(Qwen3.5-397B 등) 옵션은 아래 [성능은 얼마나 떨어지는가](#성능은-얼마나-떨어지는가--frontier-대비-위치-2026-06-검증) 참고. 벤치마크는 harness·설정에 따라 ±편차가 있으니 **도입 전 실제 워크로드로 PoC 실측** 권장.

---

- **Region 고정**: `ap-northeast-2` (Seoul) — 코드상 하드코딩 (NCT 요건 지원)
- **스택 수**: 16개 (옵션 테스트 클라이언트 포함 시 17개)
- **서빙 중 모델**: 6종 vLLM (scale-to-zero) + 2종 Bedrock (ON_DEMAND, IN_REGION)
- **엔드포인트**: HTTPS 443, Route53 Private Hosted Zone (`*.nct-gateway.internal`)

---

## Architecture

![NCT GenAI Gateway architecture](docs/architecture/nct-architecture.png)

연구원 PC(내부망)에서 Direct Connect / Site-to-Site VPN으로 HTTPS 443 요청 →
Route 53 Private Hosted Zone(`*.nct-gateway.internal`) → SmartRouter(ECS Fargate, prompt 분석·재작성, Anthropic Messages API 호환) →
Higress AI Gateway(EKS, Anthropic↔OpenAI 변환·key-auth, 6 vLLM + 2 Bedrock provider) →
**EKS Auto Mode**(vLLM × 6, scale-to-zero, Karpenter cpu/gpu/neuron, S3 Mountpoint CSI 모델 캐시) 또는
**Amazon Bedrock**(Seoul in-region fallback). vLLM alias가 cold면 SmartRouter가 pre-flight로 감지해 Bedrock으로 직접 fallback한다(gateway 우회).
Reservation(EventBridge + Lambda + DynamoDB + Step Functions)이
평일 08:30–19:30 KST 스케줄로 vLLM warmup/cooldown을 제어한다. 전 구간이 단일 리전(Seoul) 안에서 동작한다.

> 편집 가능한 원본: [`docs/architecture/nct-architecture.drawio`](docs/architecture/nct-architecture.drawio) (draw.io)

---

## CDK Stacks (16개)

| Stack | 역할 |
|-------|------|
| `NctNetworkStack` | VPC 10.0.0.0/16, 3 AZ, NAT GW, VPC Endpoints (S3/DDB/ECR/STS/SM) |
| `NctEksStack` | EKS Auto Mode v1.32, S3 Mountpoint CSI driver, model-cache S3 bucket |
| `NctKarpenterStack` | NodePools: cpu / gpu (amd64) / neuron |
| `NctVllm-Coding` | Qwen3.5-27B (g5.12xlarge, 4×A10G) |
| `NctVllm-Video` | Qwen3.5-27B (g5.12xlarge, 4×A10G, vision/video) |
| `NctVllm-Ocr` | InternVL3-14B (g5.12xlarge, 4×A10G) |
| `NctVllm-Math` | Gemma 4 31B (g6e.12xlarge, 4×L40S) |
| `NctVllm-Audio` | Phi-4 Multimodal (g5.xlarge, 1×A10G) |
| `NctVllm-Longcontext` | LLaMA 4 Scout 17B-16E (g6e.48xlarge, 8×L40S) |
| `NctCertStack` | Self-signed wildcard cert `*.nct-gateway.internal` → ACM + Secrets Manager (CA) |
| `NctHigressStack` | Higress AI Gateway (EKS Helm) + Bedrock IAM user / consumer-key Secrets. Helm release + internal NLB 443은 `NctEksStack`에 렌더 |
| `NctSmartRouterStack` | SmartRouter ECS Fargate, Internal ALB 443 |
| `NctWarmupStack` | Step Functions (Warmup / Cooldown) |
| `NctReservationStack` | DynamoDB reservation + reserve/expire Lambda + EventBridge |
| `NctAdminConsoleStack` | FastAPI ECS + ALB (`admin.nct-gateway.internal`) |
| `NctDnsStack` | Route53 PHZ `nct-gateway.internal` + alias records |

---

## Model Matrix

### vLLM (EKS Auto Mode, scale-to-zero)

| Alias | 모델 | EC2 | GPU | Max Ctx | Loading Time (캐시 있음) | 주요 벤치마크 |
|-------|------|-----|-----|---------|--------------------------|---------------|
| `coding` | Qwen3.5-27B | g5.12xlarge | 4×A10G | 32,768 | ~8 분 | SWE-bench 72.4% / LCB v6 80.7% |
| `video` | Qwen3.5-27B | g5.12xlarge | 4×A10G | 32,768 | ~8 분 | MMMU 85.0 (vision/video) |
| `ocr` | InternVL3-14B | g5.12xlarge | 4×A10G | 8,192 | ~5 분 | DocVQA 94.1 / OCRBench 875 |
| `math` | Gemma 4 31B | g6e.12xlarge | 4×L40S | 32,768 | ~6–8 분 | AIME 2026 89.2% / GPQA 84.3% |
| `audio` | Phi-4 Multimodal | g5.xlarge | 1×A10G | 16,384 | ~5–7 분 | 통합 audio+vision |
| `longcontext` | LLaMA 4 Scout 17B-16E | g6e.48xlarge | 8×L40S | 131,072 | **~35 분** | 128K context / MoE (17B active) |

- **scale-to-zero**: `minReplicas=0` — 미사용 시 GPU 노드 해제, 다음 요청 시 Karpenter가 노드 프로비저닝 + vLLM 시작
- **all warmup (병렬)**: LLaMA 4 Scout 기준 ~35 분 (가장 느린 모델이 결정)
- **캐시 위치**: S3 Mountpoint (`s3://<model-cache-bucket>/<servingName>/`)
- **LLaMA 4 Scout 특이사항**: `--enforce-eager` 필수 (CUDA graph capture 비활성화, 부팅 20분 초과 방지)

### 성능은 얼마나 떨어지는가 — frontier 대비 위치 (2026-06 검증)

> 데이터 주권 요건 때문에 frontier proprietary 모델(Claude Opus, GPT 등)을 직접 못 쓰고 self-host open-weight로 대체할 때, **얼마나 성능을 양보하는지**를 먼저 알고 도입을 결정해야 한다.

현행 `coding` alias의 **Qwen3.5-27B**를 frontier 상한과 비교하면 (정규화 = `max(GPT-5.5, Claude Opus 4.8)`를 100으로):

| 축 | Qwen3.5-27B | frontier 상한 | **frontier 대비** |
|----|-------------|---------------|-------------------|
| 코딩 (SWE-bench Verified) | 72.4 | 88.6 (Opus 4.8) | **≈ 82%** |
| 지식 (GPQA Diamond) | 85.5 | 93.6 | ≈ 91% |
| 수학 (AIME 2026) | 90.8 | ~96.7 | ≈ 94% |
| 코드 생성 (LiveCodeBench v6) | 80.7 | ~88 | ≈ 92% |

- **헤드라인: 가장 까다로운 축인 agentic 코딩(SWE-bench)에서 frontier의 ≈ 82% 수준.** 지식·수학으로 갈수록 격차가 줄어 90% 이상으로 근접한다. 남는 갭은 "가장 어려운 agentic 코딩"에 집중된다.
- **vs. 서울 in-region 매니지드 baseline**: NCT로 서울에 갇히면 Bedrock Claude 3.5 Sonnet(`2024-06-20`)이 사실상 유일한 frontier급 매니지드 옵션인데, 이 모델의 SWE-bench Verified는 **≈ 33%**(agentic scaffold 기준, [Anthropic](https://www.anthropic.com/news/swe-bench-sonnet)) = frontier의 **≈ 37%**. 업데이트판 `2024-10-22`도 ≈ 49%(≈ 55%). **self-host Qwen3.5-27B(72.4%, ≈ 82%)는 in-region 매니지드 대비 코딩 능력을 2배 이상**으로 끌어올린다. 이것이 이 repo의 핵심 가치다 (위 [왜 이 repo가 필요한가](#왜-이-repo가-필요한가) 참고).
- **더 높은 충실도가 필요하면** 동일 Qwen3.5 패밀리(전부 Apache-2.0, self-host 가능)의 플래그십 **Qwen3.5-397B-A17B**(403B MoE / 17B active)로 `coding` alias를 교체할 수 있다 — SWE-bench **76.4** (frontier의 ≈ 86%), 지식·수학은 94–99%. 단 H200(P5en) 다수가 필요해 비용이 크게 증가한다.
- ⚠️ **수치 해석 주의**: SWE-bench는 harness·vendor마다 ±3~5점 편차가 있고, 위 Qwen 수치는 모델카드의 peak reasoning mode 기준이라 실서비스 기본 설정에선 더 낮을 수 있다. **도입 전 실제 워크로드로 PoC 실측**을 권장한다.
- 출처: Qwen 공식 HF 모델카드(`Qwen/Qwen3.5-27B`, `Qwen/Qwen3.5-397B-A17B`) + vals.ai(SWE-bench) · llm-stats(GPQA) · Artificial Analysis 교차검증.

### Bedrock (ON_DEMAND / IN_REGION Seoul)

| Alias | Bedrock Model ID | 용도 |
|-------|------------------|------|
| `claude-3-5-sonnet-20241022` | `anthropic.claude-3-5-sonnet-20240620-v1:0` | Claude Code CLI 기본 target |
| `claude-3-haiku-20240307` | `anthropic.claude-3-haiku-20240307-v1:0` | 빠른/저비용 처리 (⚠️ 모델 EOL 일정은 Bedrock 콘솔에서 확인하고, 후속 모델로 alias를 갱신할 것) |

> **Alias ≠ 서빙 모델 ID**: 첫 행의 client alias(`...20241022`)와 실제 서빙 Bedrock Model ID(`...20240620-v1:0`)는 의도적으로 다르다. 왼쪽은 Claude Code CLI가 보내는 model 문자열이고, 오른쪽은 서울 in-region에서 실제 응답하는 Sonnet 3.5다. CLI가 어떤 Sonnet alias를 보내든 in-region 모델로 매핑되도록 한 것.

> **"OpenAI 계열"이 필요한 경우**: proprietary GPT(예: gpt-5.x)는 가중치가 비공개라 self-host가 불가능하다. 반면 open-weight **gpt-oss-20b / gpt-oss-120b**는 vLLM alias로 추가해 Seoul in-region으로 운영할 수 있다. Bedrock 경유 경로는 서울 in-region 제공 여부를 콘솔에서 확인 후 사용한다.

---

## Endpoints

| 용도 | URL | 백엔드 |
|------|-----|--------|
| 통합 진입점 (Anthropic 호환) | `https://gateway.nct-gateway.internal` | SmartRouter → Higress |
| Admin Console (운영자 전용) | `https://admin.nct-gateway.internal` | FastAPI |

모두 **Internal ALB + ACM(self-signed CA) + HTTPS 443**. Direct Connect / Site-to-Site VPN 필요.

---

## Researcher Onboarding

### 최초 1회 세팅

1. **CA 인증서 설치** — Secrets Manager에서 CA cert 받아 시스템 trust store에 등록
   ```bash
   aws secretsmanager get-secret-value \
     --secret-id /nct/gateway/ca-cert \
     --query SecretString --output text \
     --region ap-northeast-2 > nct-gateway-ca.crt
   # macOS
   sudo security add-trusted-cert -d -r trustRoot \
     -k /Library/Keychains/System.keychain nct-gateway-ca.crt
   ```

2. **API 키 발급 요청** — Gateway 운영자에게 요청. 현재는 단일 공유 마스터 키.

3. **Claude Code CLI 설정**
   ```bash
   export ANTHROPIC_BASE_URL=https://gateway.nct-gateway.internal
   export ANTHROPIC_API_KEY=<발급받은-토큰>
   claude -p "Hello"   # → Bedrock Sonnet Seoul으로 라우팅
   ```

### Alias 사용

```bash
# general: SmartRouter가 prompt 분석 후 최적 모델 선택
curl https://gateway.nct-gateway.internal/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"general","max_tokens":256,"messages":[...]}'

# 특정 alias 강제 (model 필드에 alias 직접 지정)
curl https://gateway.nct-gateway.internal/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"coding","max_tokens":256,"messages":[...]}'
```

---

## Warm-up / Reservation

vLLM 모델은 미사용 시 `scale-to-zero` 상태. 첫 요청 시 5~35분 콜드 스타트가 발생한다. 사전에 warm-up 하려면:

```bash
# 특정 alias 1시간 warm-up
scripts/warmup-request.sh --alias coding --requester andrew

# 복수 alias + 기간
scripts/warmup-request.sh --alias coding,math --duration 2h --requester andrew

# 전체 모델 30분
scripts/warmup-request.sh --alias all --duration 30m
```

- 예약은 DynamoDB `NctWarmupReservations`에 저장 → `reserve-fn`이 Warmup SFN 트리거
- 만료 시 `expire-fn`이 Cooldown SFN 트리거 (겹치는 예약 있으면 연장)
- **자동 스케줄**: 평일 08:30~19:30 KST, EventBridge rule로 모든 alias 자동 warm-up
- **Admin Console**: `https://admin.nct-gateway.internal` — 현재 예약/상태 확인 및 수동 조작

---

## Admin Console

- URL: `https://admin.nct-gateway.internal` (내부망)
- 인증: Basic Auth — 비밀번호는 Secrets Manager `/nct/admin-console/password`
- 기능:
  - 현재 alias별 replicas / 노드 상태
  - Active reservations 목록 / 남은 시간
  - 수동 warm-up / cool-down
  - Gateway 로그 / Bedrock 호출 통계 (기본)

---

## NCT 요건 지원 체크리스트

> ⚠️ 아래 기술 통제는 NCT 요건을 **지원**하는 것이지, 이 코드를 배포한다고 자동으로 규정을 "준수"하게 되는 것은 아니다. 실제 NCT 컴플라이언스는 조직의 정책·인력 접근통제·감사·법적 검토를 포함한 종합 판단이며, 반드시 자체 보안/법무 검토를 거쳐야 한다.

| 요건 | 지원하는 기술 통제 |
|------|--------------------|
| 모든 추론 Seoul 리전 | `bin/nct-genai-gateway.ts` — region 하드코딩 |
| Bedrock IN_REGION only | `config/models.ts` BEDROCK_MODELS 전부 `ap-northeast-2` |
| Bedrock ON_DEMAND only | Provisioned Throughput / Cross-region Inference 미사용 |
| 연구원 네트워크 격리 | Internal ALB + Route53 PHZ, public endpoint 없음 |
| 데이터 in transit 암호화 | ACM + HTTPS 443 (self-signed wildcard cert) |
| 모델 가중치 격리 | S3 bucket 서울 리전, prefix per alias, 노드 IAM scope |
| AWS API egress | VPC Endpoints (S3/DDB/ECR/STS/SM) — NAT 우회 |

> **왜 Cross-Region Inference(CRIS)를 쓰지 않는가?** Bedrock에서 frontier 모델을 Seoul에서 호출하더라도, 그 모델이 in-region이 아니라 CRIS(geographic inference profile)로만 제공되면 추론 중 input prompt와 output이 같은 geography(예: APAC) 내 타 리전으로 전송된다 — 저장은 source 리전에만 남지만 **처리는 Seoul을 벗어난다** ([AWS 문서](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html): *"your input prompts and output results might move outside of your source Region during cross-Region inference"*). 데이터의 국내 체류가 요건인 환경에서는 부적합하다. 본 게이트웨이는 (1) Seoul **IN_REGION on-demand** Bedrock 모델만 사용하고, (2) 그 외에는 EKS 위 **self-host vLLM**으로 라우팅하여 추론이 Seoul을 벗어나지 않도록 강제한다.

---

## Deployment

### Prerequisites
- AWS CLI configured (`ap-northeast-2` credentials)
- Node.js >= 18, `npm install -g aws-cdk`
- CDK Bootstrap in `ap-northeast-2`
- **HuggingFace token secret (필수)** — vLLM pod가 모델 weight를 받을 때 쓴다. 배포 전에 Secrets Manager에 미리 만들어 둔다. **없으면 vLLM pod가 기동에 실패하고(GPU 노드는 점유한 채 과금) `NctEksStack` 배포가 즉시 멈춘다** (deploy-time sanity check가 `hf-token` 부재를 잡는다):

  ```bash
  aws secretsmanager create-secret \
    --name hf-token \
    --secret-string '{"token":"hf_xxxxxxxx"}' \
    --region ap-northeast-2
  ```

  > 토큰 키 이름은 반드시 `token`. gated 모델(예: LLaMA 4 Scout)은 해당 HF 계정에서 라이선스 승인이 선행돼야 한다.

### Deploy (2-command)

게이트웨이 데이터플레인의 핵심은 k8s가 **배포 후에** 띄우는 NLB(vLLM 6개 + Higress gateway)다. 그 DNS는 배포 시점에 알 수 없어 CDK 토큰으로 못 박으므로, **인프라 배포**와 **후처리 배선**을 두 명령으로 나눈다:

```bash
npm install

# [1] 인프라 — 전체 스택 배포 (~60-90분, EKS Auto Mode + 16 스택)
AWS_DEFAULT_REGION=ap-northeast-2 cdk deploy --all

# [2] 후처리 — NLB DNS 조회 → SmartRouter 재배선 → Higress 구성 적용
./scripts/finalize-deploy.sh
```

`finalize-deploy.sh`가 다음을 한 번에 처리한다(복붙 0회):

1. **NLB DNS 조회** — vLLM 6개 + Higress gateway NLB DNS를 `kubectl`로 조회해 `cdk.json` context(`vllmEndpoints`, `higressEndpoint`)에 기입 (`scripts/get-endpoints.sh --write-context`).
2. **SmartRouter 재배선** — `cdk deploy NctSmartRouterStack -c higressEndpoint=<조회값>`으로 upstream을 Higress gateway NLB로 연결.
3. **Higress 구성 적용** — provider/route/key-auth consumer를 console REST로 적용 (`scripts/apply-higress.sh`). **첫 배포라 console admin이 없으면 `/system/init`로 자동 부트스트랩**(admin PW = gateway master-key로 고정, 이후 Secrets Manager로 복구 가능).

완료되면 진입점(`https://gateway.nct-gateway.internal`)·master-key 조회법·테스트 클라이언트 체험법을 배너로 출력한다. 재실행은 멱등(NLB 재조회 → SmartRouter no-op → Higress upsert).

> **운영자 주의**: `cdk.json`의 `operatorRoleArns`는 비어 있는 상태로 배포된다(`vllmEndpoints`·`higressEndpoint`는 `finalize-deploy.sh`가 채운다). break-glass kubectl용 role ARN은 `-c operatorRoleArns='["arn:aws:iam::<account>:role/<role>"]'`로 넘기거나(또는 본인 `cdk.json`에 지정), 빈 값이면 코드가 그대로 처리한다.

### 단계별 배포 (권장)

```bash
# Phase 0: 네트워크 + EKS + Karpenter
cdk deploy NctNetworkStack NctEksStack NctKarpenterStack

# Phase 1-6: 모델별 vLLM (선택적)
cdk deploy NctVllm-Coding
# (연구원 피드백 후 나머지 추가)

# Phase 7-10: 인증서 + Higress + SmartRouter + Warmup + Reservation + Admin + DNS
#   (NctHigressStack의 Helm release·NLB는 NctEksStack에 렌더되므로 NctEksStack도 함께 재배포)
cdk deploy NctCertStack NctEksStack NctHigressStack NctSmartRouterStack \
           NctWarmupStack NctReservationStack NctAdminConsoleStack NctDnsStack

# 후처리: NLB DNS 조회 → SmartRouter 재배선 → Higress 구성 적용
./scripts/finalize-deploy.sh
```

---

## Try it: in-VPC 테스트 클라이언트 (선택)

게이트웨이를 **직접 체험**하고 싶다면, VPC 안에 테스트용 EC2 1대를 함께 띄울 수 있다. Claude Code(GenAI harness)가 미리 설치·게이트웨이 연결까지 끝난 상태로 부팅되고, **SSM Session Manager로만** 접속한다(public IP·SSH 없음, SSM VPC endpoint 경유).

```bash
# 옵션 게이트로 활성화 (기본 off) — 기존 16스택 + NctTestClientStack
cdk deploy --all -c deployTestClient=true
```

핵심은 **같은 명령으로 cold/warm을 비교**하는 것이다. 클라이언트는 model 하나(`general`)만 고정하고, 전환은 SmartRouter의 자동 fallback이 처리한다:

```bash
# 1) SSM으로 접속 (인스턴스 ID는 NctTestClientStack output)
aws ssm start-session --target <instance-id> --region ap-northeast-2

# 안내 보기
nct-demo

# 2) warm-up 전 (GPU cold): vLLM alias가 0 replica → SmartRouter가 cold를 감지해
#    in-region Bedrock(Claude 3.5 Sonnet, 서울)으로 직접 fallback
claude "이 함수를 읽기 좋게 리팩터링해줘: ..."

# 3) GPU 모델 기동 (수 분 소요, nct-status로 폴링)
nct-warmup coding
nct-status          # SUCCEEDED = 준비 완료

# 4) warm-up 후: 똑같은 명령이 이제 self-host Qwen3.5-27B(vLLM)로 라우팅
claude "이 함수를 읽기 좋게 리팩터링해줘: ..."

# 5) 끝나면 GPU 과금 정지
nct coding          # 해당 alias를 0 replica로 복귀
```

| 헬퍼 | 동작 |
|------|------|
| `nct-warmup <alias>` | alias의 vLLM deployment를 기동 (Warmup SFN) |
| `nct-status` | 최근 warm-up 실행 상태 (RUNNING→SUCCEEDED) |
| `nct <alias>` | alias를 scale-to-zero로 복귀 (Cooldown SFN) |
| `nct-demo` | 위 시나리오 안내 출력 |

> **자동 전환 원리**: 클라이언트는 항상 `ANTHROPIC_MODEL=general`. SmartRouter는 Higress로 보내기 **전에** 해당 alias의 vLLM NLB `/health`를 ~2s로 pre-flight 한다. cold(healthy target 0)면 gateway를 건너뛰고 곧장 Bedrock Seoul로 직접 fallback(boto3, Anthropic Messages native)하고, warm이면 Higress→vLLM 정상 경로로 간다. gateway나 vLLM이 에러를 반환하는 경우에도 reactive fallback(Bedrock-direct)이 안전망으로 동작한다. 클라이언트 코드·모델명 변경 없이 동일 명령으로 두 백엔드를 비교 체험.

---

## Key Design Decisions

### EKS Auto Mode v1.32
- `aws-cdk-lib/aws-eks-v2` 사용 (Auto Mode 지원)
- NodePool 중 `system`, `general-purpose`만 활성, GPU는 Karpenter가 프로비저닝
- EBS CSI provisioner: `ebs.csi.eks.amazonaws.com` (Auto Mode 전용)

### 모델 캐시: S3 Mountpoint (EFS 대체)
- EKS Auto Mode + EFS CSI v3.x + Bottlerocket 조합에서 `amazon-efs-mount-watchdog` init system 미감지로 TLS 기반 NFS mount 실패 (I1)
- S3 Mountpoint CSI (`aws-mountpoint-s3-csi-driver`)로 우회 — alias별 prefix로 격리, 노드 IAM 권한 스코핑
- 재부팅/노드 교체 후에도 가중치 캐시 영속화

### Scale-to-zero + Warm-up
- `minReplicas=0` 기본값 → GPU 비용 상시 지출 없음
- Karpenter ExistNow/ProvisionUnderThreshold 이벤트로 노드 생성, vLLM init에 5~35분 소요
- Warm-up은 Step Functions로 오케스트레이션 (I7 수정: 최대 50분 timeout)

### Smart Routing & Bedrock-direct fallback
- `general` alias 요청 시 prompt embedding 분석 → scenario 감지 → `coding`/`math`/... 모델로 재작성
- `model` 필드에 alias를 직접 지정하면 SmartRouter가 그대로 통과(scenario 감지 생략)
- vLLM alias가 cold면 SmartRouter가 pre-flight로 감지 → Higress를 우회하고 Bedrock(Anthropic Messages native, boto3)으로 직접 fallback. gateway/vLLM 에러 시에도 reactive fallback이 안전망

### Higress Anthropic ↔ OpenAI 변환
- Claude Code는 `thinking`, `betas`, `anthropic_version` 등 Anthropic 전용 파라미터를 `/v1/messages`로 전송
- Higress AI Gateway가 Anthropic Messages를 OpenAI Chat Completions로 native 변환해 vLLM(OpenAI 호환)에 전달하고, 응답을 Anthropic 양식으로 역변환한다 (이전 LiteLLM의 `drop_params`/수동 sanitize를 대체)

### Pod Identity > IRSA
- Bedrock 호출, S3 Mountpoint 모두 EKS Pod Identity 사용
- S3 Mountpoint CSI는 OIDC 기반 IRSA 경로도 함께 구성

---

## Cost Model

### scale-to-zero (상시)
| 컴포넌트 | 인스턴스 | 시간당 |
|----------|----------|--------|
| EKS Control Plane | — | $0.10 |
| Karpenter system nodes | m5.large | ~$0.10 |
| SmartRouter / Admin ECS | Fargate (0.5 vCPU × 2) | ~$0.07 |
| Higress (gateway/controller/console) | EKS pods (non-GPU 노드) | EKS 노드 비용에 포함 |
| Internal LB × 3 (SmartRouter ALB + Admin ALB + Higress NLB) | — | ~$0.07 |
| NAT GW | — | ~$0.05 |
| S3 Storage (모델 캐시) | ~500 GB | ~$0.02 |
| **상시 합계** | | **\~$0.45/hr (\~$324/month)** |

### vLLM 모델 기동 시 (alias 별)
| Alias | 인스턴스 | 시간당 추가 |
|-------|----------|-------------|
| coding / video / ocr | g5.12xlarge | ~$5.67 |
| math | g6e.12xlarge | ~$3.90 |
| audio | g5.xlarge | ~$1.00 |
| longcontext | g6e.48xlarge | ~$30.90 |

자동 스케줄(평일 08:30~19:30 KST, 11h × 21일) 기준 전체 warm-up 시 월 비용:
- coding + video + ocr + math + audio: \~$17/hr × 231h = \~$3,927
- + longcontext (필요 시만): +$30.90/hr × 사용시간

> 비용 최적화: `longcontext`는 예약(`--alias longcontext`)으로만 기동. 필요 없는 alias는 `minReplicas=0` 유지.

---

## Operations

### 수동 스케일
```bash
# alias 즉시 기동 (Warmup SFN 우회)
kubectl scale deployment <servingName> -n vllm --replicas=1

# alias 즉시 해제
kubectl scale deployment <servingName> -n vllm --replicas=0
```

### 로그
- vLLM: `kubectl logs deploy/<servingName> -n vllm -f`
- Higress: `kubectl logs deploy/higress-gateway -n higress-system -f`
- SmartRouter: CloudWatch Logs `/ecs/nct-smart-router`
- Admin Console: CloudWatch Logs `/ecs/nct-admin-console`
- Warmup SFN: Step Functions console `NctWarmup`/`NctCooldown`

### 헬스 체크
```bash
# SmartRouter (게이트웨이 진입점)
curl https://gateway.nct-gateway.internal/health/liveliness

# Higress gateway (in-cluster, NLB DNS로)
kubectl exec -n vllm <curl-pod> -- curl -sk https://<higress-nlb>:443/
```

---

## 검증 결과 (Test Report)

배포된 환경에서 게이트웨이 진입점(`gateway.nct-gateway.internal`, Anthropic Messages API `/v1/messages`, `x-api-key` 마스터 키)으로 in-VPC 클라이언트에서 실측한 결과다. 4개 핵심 경로가 모두 통과했고, 운영 중 발견한 corner case 3종을 해결했다.

> ⚠️ 아래는 특정 배포에서의 실측 스냅샷이다. 모델 버전·벤치마크·지연 수치는 배포 환경·시점에 따라 달라질 수 있으니 **도입 전 자체 환경에서 재현**할 것.

### E2E 경로 (4/4 PASS)

| # | 시나리오 | 경로 | 결과 |
|---|----------|------|------|
| 1 | **cold → Bedrock** | vLLM scale-0 상태에서 요청 → SmartRouter pre-flight가 cold 감지 → Bedrock-direct | HTTP 200, `x-nct-fallback: bedrock-direct`, `claude-3-5-sonnet` 응답 |
| 2 | **warm → vLLM (non-stream)** | vLLM warm 상태 → Higress → vLLM 직접 | HTTP 200, `model: qwen35-27b`, fallback 헤더 없음 |
| 3 | **tool use → vLLM direct** | warm tool-call 요청 → vLLM 직접 처리 | HTTP 200, structured `tool_use` block, `stop_reason: tool_use`, fallback 없음 |
| 4 | **streaming → vLLM** | `stream:true` warm 요청 | HTTP 200, `text/event-stream`, native Anthropic SSE(`message_start`→`content_block_delta`×N→`message_stop`) |

### 해결한 corner case (3종)

| 증상 | 근본 원인 | 해결 |
|------|-----------|------|
| **cold 요청 ~41초 지연** | vLLM alias가 scale-0면 NLB target이 0개 → Envoy(Higress)가 dead upstream에 ~40초 hang 후 503 | SmartRouter가 Higress 호출 **전** 해당 alias의 vLLM NLB `/health`를 2초 timeout으로 직접 pre-flight. cold면 gateway 우회하고 즉시 Bedrock-direct → **41초 → ~2.5초** |
| **tool-call XML이 평문으로 누출** | `--tool-call-parser hermes`는 JSON-in-`<tool_call>`을 기대하지만 Qwen3.5-27B는 XML 형식(`<tool_call><function=...>`)으로 출력 → 파서가 못 잡고 평문 누출 | parser를 `qwen3_xml`로 교체(`config/models.ts`의 `coding`·`video`) → structured `tool_use` block으로 vLLM 직접 처리 |
| **Bedrock `/v1/messages` SigV4 실패** | Higress ai-proxy 2.0.0은 Bedrock의 Anthropic Messages를 native 미지원 → OpenAI Chat→Bedrock Converse 2단 변환 중 SigV4 scope 에러([higress#3809]) | gateway-level fallback 제거. SmartRouter가 vLLM 실패 시 Bedrock의 native `/v1/messages`를 boto3로 **직접** 호출(gateway 우회) — Bedrock이 Anthropic 본문을 그대로 수용 |

[higress#3809]: https://github.com/alibaba/higress/issues/3809

---

## Known Issues

| # | 이슈 | 상태 |
|---|------|------|
| I1 | Bottlerocket + EFS TLS mount 실패 | S3 Mountpoint로 우회 (운영 안정) |
| I8 | 연구원별 독립 API 키 미지원 | 단일 공유 마스터 키. 향후 Higress consumer key-auth(연구원별 consumer)로 분리 예정 |
| — | Bedrock 모델 EOL | Seoul IN_REGION 후속 모델로 alias 갱신 필요. EOL 일정은 Bedrock 콘솔에서 확인 |

---

## Cleanup

```bash
cdk destroy --all --force
```

- EKS Auto Mode 삭제 ~15분
- S3 model-cache bucket은 RETAIN 정책 (가중치 보존)

---

## Related

- [vLLM 문서](https://docs.vllm.ai)
- [Higress 문서](https://higress.cn/en/docs/latest/overview/what-is-higress/)
- [Amazon EKS Auto Mode](https://docs.aws.amazon.com/eks/latest/userguide/automode.html)
- [Claude Code — LLM Gateway 설정](https://code.claude.com/docs/en/llm-gateway)
- [NCT 근거법 (산업기술의 유출방지 및 보호에 관한 법률)](https://www.law.go.kr/법령/산업기술의유출방지및보호에관한법률)
