# NCT GenAI Gateway

> 🌏 **English**: see [README.en.md](README.en.md). 본 문서(한국어)가 정본입니다.

모든 추론이 한국(Seoul) 리전에서만 발생하도록 강제하는 region-locked LLM Gateway 샘플입니다. 연구원이 **Claude Code CLI**를 그대로 사용하면서, 내부적으로는 Bedrock(Claude Sonnet/Haiku) 또는 EKS 위의 6종 오픈소스 vLLM 모델로 라우팅됩니다.

> **NCT(국가핵심기술)란?** 한국 「산업기술의 유출방지 및 보호에 관한 법률」이 정한 국가핵심기술입니다. 클라우드 이용 시 데이터·접근 권한이 국외로 나가지 않도록 요구됩니다([근거법](https://www.law.go.kr/법령/산업기술의유출방지및보호에관한법률)). 이 샘플은 그 요건을 AWS Seoul 리전 단일 운영으로 충족하는 아키텍처를 보여줍니다.

> **Disclaimer — 프로덕션 용도 아님.** 본 저장소는 교육·데모 목적의 샘플 코드이며 **프로덕션 사용을 위한 것이 아닙니다**. 어떠한 보증도 없이 "있는 그대로(as is)" 제공됩니다. 배포 전 반드시 자체 보안·컴플라이언스·운영 요건에 맞춰 검토·강화·테스트하십시오. NCT(국가핵심기술) 관련 기술은 이 아키텍처가 보여주는 *지원 컨트롤(supporting controls)*을 설명한 것으로, 규제 준수에 대한 인증이나 법적 보증이 아닙니다.

---

## TL;DR

**누가** — NCT(국가핵심기술)로 모든 추론을 서울 리전 안에 묶어야 하는 한국 제조·방산·반도체 고객.
**무엇** — 연구원은 **Claude Code CLI를 그대로** 쓰고, gateway가 내부적으로 서울 in-region Bedrock 또는 self-host open-source vLLM(EKS)으로 라우팅합니다. 트래픽이 리전을 벗어나지 않습니다.
**왜** — 서울 in-region 매니지드 모델만 쓰면 frontier의 ~37% 수준에 갇히지만, 이 repo의 self-host `coding`(Qwen3.5-27B)은 frontier의 **~82%** 수준을 in-region으로 냅니다.

**어떻게 (배포 → 체험 → 정리):**

```bash
npm install

# [1] 인프라 — 전체 스택 배포 (~60-90분, EKS Auto Mode + 17 스택, 테스트 클라이언트 포함)
AWS_DEFAULT_REGION=ap-northeast-2 cdk deploy --all

# [2] 후처리 — NLB DNS 조회 → SmartRouter 재배선 → Higress 구성 적용
./scripts/finalize-deploy.sh

# [3] 체험 — VPC 안 테스트 클라이언트(EC2 + Claude Code)에 SSM 접속
aws ssm start-session --target <NctTestClientStack 의 InstanceId>

# [4] 테스트 — cold 면 Bedrock(Seoul); `nct-warmup coding` 후 같은 명령이 vLLM(Qwen3.5)로
claude "이 함수를 읽기 좋게 리팩터링해줘: ..."

# [5] 정리 — 데모 종료 시 전체 삭제
cdk destroy --all --force
```

> **배포 전 필수 준비**가 있습니다 — HuggingFace 토큰(필수)과, `longcontext`·`math`를 쓸 경우 gated 모델 라이선스 승인입니다. 먼저 **[Prerequisites](#prerequisites)** 를 확인하고 시작하십시오. 단계별 배포·체험·운영 옵션은 **[Deployment](#deployment)** 를 참고하십시오.

- **Region 고정**: `ap-northeast-2` (Seoul) — 코드상 하드코딩 (NCT 요건 지원)
- **스택 수**: 17개 (테스트 클라이언트 기본 포함; `-c deployTestClient=false`로 제외 시 16개)
- **서빙 중 모델**: 6종 vLLM (scale-to-zero) + 2종 Bedrock (ON_DEMAND, IN_REGION)
- **엔드포인트**: HTTPS 443, Route53 Private Hosted Zone (`*.nct-gateway.internal`)

---

<details>
<summary><strong>왜 이 repo가 필요한가</strong> — NCT로 서울 in-region에 갇히면 frontier의 ~37%, 이 repo는 self-host로 ~82%까지 끌어올립니다 (펼쳐서 논증·벤치마크 보기)</summary>

### 왜 이 repo가 필요한가

**문제.** NCT(국가핵심기술)를 다루는 한국 제조·방산·반도체 고객은 데이터와 접근 권한이 국외로 나가면 안 됩니다. 그래서 LLM도 **서울(ap-northeast-2) 리전 안에서만** 돌려야 합니다. 그런데 서울 in-region으로 즉시 쓸 수 있는 frontier 사양의 매니지드 모델은 사실상 **Amazon Bedrock의 Claude 3.5 Sonnet** 하나뿐입니다 (cross-region inference를 쓰면 트래픽이 리전을 벗어나 NCT 요건에 어긋납니다).

**그 대가가 얼마인가.** Bedrock 서울에 in-region으로 잡히는 Claude 3.5 Sonnet(`2024-06-20`)은 agentic 코딩 기준 **SWE-bench Verified ≈ 33%** 입니다. 오늘의 frontier 상한(Claude Opus 4.8 ≈ 88.6%) 대비 **≈ 37% 수준**에 불과합니다. 즉 "규정을 지키려고 서울에 갇히는 순간, 코딩 능력의 60% 이상을 포기"하게 됩니다. (업데이트판 `2024-10-22`를 쓸 수 있어도 ≈ 49% = frontier의 ≈ 55%로, 갭은 여전히 큽니다.)

**이 repo의 해법 — frontier를 ~82%까지 끌어올리는 hedge.** 가중치가 공개된 open-source 모델을 서울 리전 EKS에 self-host하면, 트래픽이 리전을 벗어나지 않으면서도 훨씬 높은 성능을 낼 수 있습니다. 이 CDK가 기본 탑재한 `coding` 모델 **Qwen3.5-27B**는 **SWE-bench Verified ≈ 72.4% = frontier의 ≈ 82%** 입니다 (지식·수학 축은 90% 이상으로 더 근접). in-region Bedrock(≈37%)에서 **두 배 이상**으로 올라갑니다.

| 서울 in-region 선택지 | SWE-bench Verified | frontier(Opus 4.8=88.6) 대비 |
|----|----|----|
| Bedrock Claude 3.5 Sonnet (`2024-06-20`) — 매니지드 유일 옵션 | ≈ 33% | **≈ 37%** |
| Bedrock Claude 3.5 Sonnet (`2024-10-22`) | ≈ 49% | ≈ 55% |
| **이 CDK의 `coding` = Qwen3.5-27B (self-host)** | **≈ 72.4%** | **≈ 82%** |

**메시지.** *"NCT 때문에 서울에 갇혀 frontier의 37%짜리 모델밖에 못 쓴다"* 는 통념을, 이 **2-command CDK 솔루션**(`cdk deploy --all` → `finalize-deploy.sh`)이 *"frontier 대비 80% 수준을 서울 in-region으로 유지하면서 NCT를 AWS에서 준수한다"* 로 바꿉니다. frontier 100%는 아니지만 80% 수준이면 대부분의 실무를 커버하며, 무엇보다 **데이터 주권을 깨지 않습니다.**

> 수치 근거·해석 주의·더 높은 충실도(Qwen3.5-397B 등) 옵션은 아래 **Model Matrix**의 *성능은 얼마나 떨어지는가* 펼침 섹션을 참고하십시오. 벤치마크는 harness·설정에 따라 ±편차가 있으니 **도입 전 실제 워크로드로 PoC 실측**을 권장합니다.

</details>

---

## Architecture

![NCT GenAI Gateway architecture](docs/architecture/nct-architecture.png)

연구원 PC(내부망)에서 Direct Connect / Site-to-Site VPN으로 HTTPS 443 요청 →
Route 53 Private Hosted Zone(`*.nct-gateway.internal`) → SmartRouter(ECS Fargate, prompt 분석·재작성, Anthropic Messages API 호환) →
Higress AI Gateway(EKS, Anthropic↔OpenAI 변환·key-auth, 6 vLLM + 2 Bedrock provider) →
**EKS Auto Mode**(vLLM × 6, scale-to-zero, Karpenter cpu/gpu/neuron, S3 Mountpoint CSI 모델 캐시) 또는
**Amazon Bedrock**(Seoul in-region fallback)으로 라우팅됩니다. vLLM alias가 cold면 SmartRouter가 pre-flight로 감지해 Bedrock으로 직접 fallback합니다(gateway 우회).
Reservation(EventBridge + Lambda + DynamoDB + Step Functions)이
평일 08:30–19:30 KST 스케줄로 vLLM warmup/cooldown을 제어합니다. 전 구간이 단일 리전(Seoul) 안에서 동작합니다.

> 편집 가능한 원본: [`docs/architecture/nct-architecture.drawio`](docs/architecture/nct-architecture.drawio) (draw.io)

---

## Deployment

### Prerequisites

- AWS CLI configured (`ap-northeast-2` credentials)
- Node.js >= 18, `npm install -g aws-cdk`
- CDK Bootstrap in `ap-northeast-2`
- **HuggingFace 토큰 (필수)** — 아래 1번 참고.
- **Gated 모델 라이선스 승인 (선택)** — `longcontext`·`math`를 배포할 때만. 아래 2번 참고.

#### 1. HuggingFace 토큰 발급 + Secrets Manager 등록 (필수)

vLLM pod가 모델 weight를 받을 때 HF 토큰을 씁니다. **없으면 vLLM pod가 기동에 실패하고(GPU 노드는 점유한 채 과금) `NctEksStack` 배포가 즉시 멈춥니다**(deploy-time sanity check가 `hf-token` 부재를 잡습니다).

1. [huggingface.co](https://huggingface.co/join) 가입/로그인.
2. **Settings → Access Tokens → New token** → Type **Read** 선택 → 생성된 `hf_...` 토큰 복사. (weight 다운로드 전용이므로 Read 권한이면 충분.)
3. 그 토큰을 Secrets Manager에 등록 (시크릿 안의 키 이름은 반드시 `token`):

   ```bash
   aws secretsmanager create-secret \
     --name hf-token \
     --secret-string '{"token":"hf_xxxxxxxx"}' \
     --region ap-northeast-2
   ```

#### 2. Gated 모델 라이선스 승인 (선택 — `longcontext`·`math`를 쓸 때만)

기본 6종 중 **2종이 gated** = HF에서 라이선스 동의가 선행돼야 다운로드됩니다. 승인 없이 배포하면 해당 vLLM pod가 **HF 401/403**으로 기동에 실패합니다.

| Alias | 모델 | 승인 절차 |
|-------|------|-----------|
| `longcontext` | [`meta-llama/Llama-4-Scout-17B-16E-Instruct`](https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct) | 모델카드에서 Meta 라이선스 동의 + access request 승인 |
| `math` | [`google/gemma-4-31b-it`](https://huggingface.co/google/gemma-4-31b-it) | 모델카드에서 Google Gemma 라이선스 동의 |

- **반드시 위에서 토큰을 발급한 동일 HF 계정으로** 각 모델카드의 "Agree and access"(access request)를 먼저 눌러 승인받으십시오.
- 나머지 4종(`coding`/`video`=Qwen3.5-27B[Apache-2.0], `ocr`=InternVL3-14B, `audio`=Phi-4 Multimodal)은 gated가 아니므로 추가 승인이 필요 없습니다.
- **두 모델을 안 쓸 거면** 해당 vLLM 스택(`NctVllm-Longcontext`·`NctVllm-Math`)을 배포에서 빼면 됩니다(아래 *단계별 배포*에서 제외, 또는 `cdk deploy`에서 해당 스택 생략). gated 승인 없이도 나머지 스택은 정상 배포됩니다.
- ⚠️ gated 여부·라이선스 조건은 모델카드 정책이라 바뀔 수 있습니다. **배포 시점에 각 모델카드에서 확인**하십시오.

### Deploy (2-command)

게이트웨이 데이터플레인의 핵심은 k8s가 **배포 후에** 띄우는 NLB(vLLM 6개 + Higress gateway)입니다. 그 DNS는 배포 시점에 알 수 없어 CDK 토큰으로 못 박으므로, **인프라 배포**와 **후처리 배선**을 두 명령으로 나눕니다:

```bash
npm install

# [1] 인프라 — 전체 스택 배포 (~60-90분, EKS Auto Mode + 17 스택, 테스트 클라이언트 포함)
AWS_DEFAULT_REGION=ap-northeast-2 cdk deploy --all

# [2] 후처리 — NLB DNS 조회 → SmartRouter 재배선 → Higress 구성 적용
./scripts/finalize-deploy.sh
```

`finalize-deploy.sh`가 다음을 한 번에 처리합니다(복붙 0회):

1. **NLB DNS 조회** — vLLM 6개 + Higress gateway NLB DNS를 `kubectl`로 조회해 `cdk.json` context(`vllmEndpoints`, `higressEndpoint`)에 기입합니다 (`scripts/get-endpoints.sh --write-context`).
2. **SmartRouter 재배선** — `cdk deploy NctSmartRouterStack -c higressEndpoint=<조회값>`으로 upstream을 Higress gateway NLB로 연결합니다.
3. **Higress 구성 적용** — provider/route/key-auth consumer를 console REST로 적용합니다 (`scripts/apply-higress.sh`). **첫 배포라 console admin이 없으면 `/system/init`로 자동 부트스트랩합니다**(admin PW = gateway master-key로 고정, 이후 Secrets Manager로 복구 가능).

완료되면 진입점(`https://gateway.nct-gateway.internal`)·master-key 조회법·테스트 클라이언트 접속법을 배너로 출력합니다. 재실행은 멱등입니다(NLB 재조회 → SmartRouter no-op → Higress upsert).

### 체험 + 정리 (3~5)

배포에는 **VPC 안 테스트 클라이언트(EC2 1대)가 기본 포함**됩니다 — Claude Code가 미리 설치·연결된 채 부팅되고 **SSM Session Manager로만** 접속합니다. 게이트웨이를 손으로 바로 체험할 수 있습니다(상세는 [Try it](#try-it-in-vpc-테스트-클라이언트-기본-포함)).

```bash
# [3] SSM 접속 — InstanceId 는 NctTestClientStack output
INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name NctTestClientStack \
  --region ap-northeast-2 \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
aws ssm start-session --target "$INSTANCE_ID" --region ap-northeast-2

# [4] cold 면 Bedrock(Seoul). nct-warmup coding 후엔 같은 명령이 vLLM(Qwen3.5)로
claude "이 함수를 읽기 좋게 리팩터링해줘: ..."
nct-warmup coding        # GPU 기동(수 분), nct-status 로 폴링
claude "이 함수를 읽기 좋게 리팩터링해줘: ..."   # 이제 vLLM 직접
nct coding               # 끝나면 scale-to-zero (GPU 과금 정지)

# [5] 데모 종료 — 전체 스택 삭제
cdk destroy --all --force
```

> 테스트 클라이언트가 필요 없으면 `cdk deploy --all -c deployTestClient=false`로 제외합니다(스택 16개). 포함하더라도 burstable t3.small **standard credit 모드**라 idle 비용은 미미합니다(~$0.024/hr).

> **운영자 주의**: `cdk.json`의 `operatorRoleArns`는 비어 있는 상태로 배포됩니다(`vllmEndpoints`·`higressEndpoint`는 `finalize-deploy.sh`가 채웁니다). break-glass kubectl용 role ARN은 `-c operatorRoleArns='["arn:aws:iam::<account>:role/<role>"]'`로 넘기거나(또는 본인 `cdk.json`에 지정), 빈 값이면 코드가 그대로 처리합니다.

### 단계별 배포 (권장)

```bash
# Phase 0: 네트워크 + EKS + Karpenter
cdk deploy NctNetworkStack NctEksStack NctKarpenterStack

# Phase 1-6: 모델별 vLLM (선택적)
#   gated 모델(NctVllm-Longcontext, NctVllm-Math)은 HF 승인 후에만 추가
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

## Endpoints

| 용도 | URL | 백엔드 |
|------|-----|--------|
| 통합 진입점 (Anthropic 호환) | `https://gateway.nct-gateway.internal` | SmartRouter → Higress |
| Admin Console (운영자 전용) | `https://admin.nct-gateway.internal` | FastAPI |

모두 **Internal ALB + ACM(self-signed CA) + HTTPS 443**을 사용하며, Direct Connect / Site-to-Site VPN이 필요합니다.

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

2. **API 키 발급 요청** — Gateway 운영자에게 요청합니다. 현재는 단일 공유 마스터 키입니다.

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

## Try it: in-VPC 테스트 클라이언트 (기본 포함)

게이트웨이를 **직접 체험**할 수 있도록, 배포에는 VPC 안 테스트용 EC2 1대가 **기본 포함**됩니다. Claude Code(GenAI harness)가 미리 설치·게이트웨이 연결까지 끝난 상태로 부팅되고, **SSM Session Manager로만** 접속합니다(public IP·SSH 없음, SSM VPC endpoint 경유). 인스턴스는 burstable **t3.small (standard credit 모드)** 이라 idle 비용이 ~$0.024/hr로 미미하고, baseline 초과 burst는 과금이 아니라 throttle됩니다.

```bash
# 기본 포함 — `cdk deploy --all` 만으로 NctTestClientStack 이 함께 뜬다.
# 필요 없으면 제외(스택 16개):
cdk deploy --all -c deployTestClient=false
```

핵심은 **같은 명령으로 cold/warm을 비교**하는 것입니다. 클라이언트는 model 하나(`general`)만 고정하고, 전환은 SmartRouter의 자동 fallback이 처리합니다:

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

> **자동 전환 원리**: 클라이언트는 항상 `ANTHROPIC_MODEL=general`을 보냅니다. SmartRouter는 Higress로 보내기 **전에** 해당 alias의 vLLM NLB `/health`를 ~2s로 pre-flight 합니다. cold(healthy target 0)면 gateway를 건너뛰고 곧장 Bedrock Seoul로 직접 fallback(boto3, Anthropic Messages native)하고, warm이면 Higress→vLLM 정상 경로로 갑니다. gateway나 vLLM이 에러를 반환하는 경우에도 reactive fallback(Bedrock-direct)이 안전망으로 동작합니다. 클라이언트 코드·모델명 변경 없이 동일 명령으로 두 백엔드를 비교 체험할 수 있습니다.

---

## Model Matrix

### vLLM (EKS Auto Mode, scale-to-zero)

| Alias | 모델 | 라이선스 | EC2 | GPU | Max Ctx | Loading (캐시 있음) | 주요 벤치마크 |
|-------|------|----------|-----|-----|---------|---------------------|---------------|
| `coding` | Qwen3.5-27B | Apache-2.0 | g5.12xlarge | 4×A10G | 32,768 | ~8 분 | SWE-bench 72.4% / LCB v6 80.7% |
| `video` | Qwen3.5-27B | Apache-2.0 | g5.12xlarge | 4×A10G | 32,768 | ~8 분 | MMMU 85.0 (vision/video) |
| `ocr` | InternVL3-14B | MIT | g5.12xlarge | 4×A10G | 8,192 | ~5 분 | DocVQA 94.1 / OCRBench 875 |
| `math` | Gemma 4 31B | **gated** (Gemma) | g6e.12xlarge | 4×L40S | 32,768 | ~6–8 분 | AIME 2026 89.2% / GPQA 84.3% |
| `audio` | Phi-4 Multimodal | MIT | g5.xlarge | 1×A10G | 16,384 | ~5–7 분 | 통합 audio+vision |
| `longcontext` | LLaMA 4 Scout 17B-16E | **gated** (Meta) | g6e.48xlarge | 8×L40S | 131,072 | **~35 분** | 128K context / MoE (17B active) |

- **gated 모델**(`math`·`longcontext`)은 HF 라이선스 승인이 선행돼야 합니다 — [Prerequisites](#prerequisites) 2번을 참고하십시오. 안 쓰면 해당 스택을 배포에서 빼면 됩니다.
- **scale-to-zero**: `minReplicas=0` — 미사용 시 GPU 노드를 해제하고, 다음 요청 시 Karpenter가 노드를 프로비저닝하며 vLLM을 시작합니다.
- **all warmup (병렬)**: LLaMA 4 Scout 기준 ~35 분입니다 (가장 느린 모델이 결정).
- **캐시 위치**: S3 Mountpoint (`s3://<model-cache-bucket>/<servingName>/`)
- **LLaMA 4 Scout 특이사항**: `--enforce-eager`가 필수입니다 (CUDA graph capture 비활성화, 부팅 20분 초과 방지).
- ⚠️ 라이선스·벤치마크는 모델카드 기준이며 변할 수 있습니다 — **배포 시점에 각 모델카드에서 확인**하십시오.

### Bedrock (ON_DEMAND / IN_REGION Seoul)

| Alias | Bedrock Model ID | 용도 |
|-------|------------------|------|
| `claude-3-5-sonnet-20241022` | `anthropic.claude-3-5-sonnet-20240620-v1:0` | Claude Code CLI 기본 target |
| `claude-3-haiku-20240307` | `anthropic.claude-3-haiku-20240307-v1:0` | 빠른/저비용 처리 (⚠️ 모델 EOL 일정은 Bedrock 콘솔에서 확인하고, 후속 모델로 alias를 갱신하십시오) |

> **Alias ≠ 서빙 모델 ID**: 첫 행의 client alias(`...20241022`)와 실제 서빙 Bedrock Model ID(`...20240620-v1:0`)는 의도적으로 다릅니다. 왼쪽은 Claude Code CLI가 보내는 model 문자열이고, 오른쪽은 서울 in-region에서 실제 응답하는 Sonnet 3.5입니다. CLI가 어떤 Sonnet alias를 보내든 in-region 모델로 매핑되도록 한 것입니다.

> **"OpenAI 계열"이 필요한 경우**: proprietary GPT(예: gpt-5.x)는 가중치가 비공개라 self-host가 불가능합니다. 반면 open-weight **gpt-oss-20b / gpt-oss-120b**는 vLLM alias로 추가해 Seoul in-region으로 운영할 수 있습니다. Bedrock 경유 경로는 서울 in-region 제공 여부를 콘솔에서 확인한 후 사용하십시오.

<details>
<summary><strong>성능은 얼마나 떨어지는가</strong> — frontier 대비 위치, 더 높은 충실도 옵션, 수치 해석 주의 (2026-06 검증, 펼치기)</summary>

### 성능은 얼마나 떨어지는가 — frontier 대비 위치 (2026-06 검증)

> 데이터 주권 요건 때문에 frontier proprietary 모델(Claude Opus, GPT 등)을 직접 못 쓰고 self-host open-weight로 대체할 때, **얼마나 성능을 양보하는지**를 먼저 알고 도입을 결정해야 합니다.

현행 `coding` alias의 **Qwen3.5-27B**를 frontier 상한과 비교하면 다음과 같습니다 (정규화 = `max(GPT-5.5, Claude Opus 4.8)`를 100으로):

| 축 | Qwen3.5-27B | frontier 상한 | **frontier 대비** |
|----|-------------|---------------|-------------------|
| 코딩 (SWE-bench Verified) | 72.4 | 88.6 (Opus 4.8) | **≈ 82%** |
| 지식 (GPQA Diamond) | 85.5 | 93.6 | ≈ 91% |
| 수학 (AIME 2026) | 90.8 | ~96.7 | ≈ 94% |
| 코드 생성 (LiveCodeBench v6) | 80.7 | ~88 | ≈ 92% |

- **헤드라인: 가장 까다로운 축인 agentic 코딩(SWE-bench)에서 frontier의 ≈ 82% 수준입니다.** 지식·수학으로 갈수록 격차가 줄어 90% 이상으로 근접합니다. 남는 갭은 "가장 어려운 agentic 코딩"에 집중됩니다.
- **vs. 서울 in-region 매니지드 baseline**: NCT로 서울에 갇히면 Bedrock Claude 3.5 Sonnet(`2024-06-20`)이 사실상 유일한 frontier급 매니지드 옵션인데, 이 모델의 SWE-bench Verified는 **≈ 33%**(agentic scaffold 기준, [Anthropic](https://www.anthropic.com/news/swe-bench-sonnet)) = frontier의 **≈ 37%** 입니다. 업데이트판 `2024-10-22`도 ≈ 49%(≈ 55%)입니다. **self-host Qwen3.5-27B(72.4%, ≈ 82%)는 in-region 매니지드 대비 코딩 능력을 2배 이상**으로 끌어올립니다. 이것이 이 repo의 핵심 가치입니다 (상단 *TL;DR* 및 *왜 이 repo가 필요한가* 펼침 섹션 참고).
- **더 높은 충실도가 필요하면** 동일 Qwen3.5 패밀리(전부 Apache-2.0, self-host 가능)의 플래그십 **Qwen3.5-397B-A17B**(403B MoE / 17B active)로 `coding` alias를 교체할 수 있습니다 — SWE-bench **76.4** (frontier의 ≈ 86%), 지식·수학은 94–99%입니다. 단 H200(P5en) 다수가 필요해 비용이 크게 증가합니다.
- ⚠️ **수치 해석 주의**: SWE-bench는 harness·vendor마다 ±3~5점 편차가 있고, 위 Qwen 수치는 모델카드의 peak reasoning mode 기준이라 실서비스 기본 설정에선 더 낮을 수 있습니다. **도입 전 실제 워크로드로 PoC 실측**을 권장합니다.
- 출처: Qwen 공식 HF 모델카드(`Qwen/Qwen3.5-27B`, `Qwen/Qwen3.5-397B-A17B`) + vals.ai(SWE-bench) · llm-stats(GPQA) · Artificial Analysis 교차검증.

</details>

---

<details>
<summary><strong>CDK Stacks (17개)</strong> — 스택별 역할 표 (펼치기)</summary>

| Stack | 역할 |
|-------|------|
| `NctNetworkStack` | VPC 10.0.0.0/16, 3 AZ, NAT GW, VPC Endpoints (S3/DDB/ECR/STS/SM) |
| `NctEksStack` | EKS Auto Mode v1.32, S3 Mountpoint CSI driver, model-cache S3 bucket |
| `NctKarpenterStack` | NodePools: cpu / gpu (amd64) / neuron |
| `NctVllm-Coding` | Qwen3.5-27B (g5.12xlarge, 4×A10G) |
| `NctVllm-Video` | Qwen3.5-27B (g5.12xlarge, 4×A10G, vision/video) |
| `NctVllm-Ocr` | InternVL3-14B (g5.12xlarge, 4×A10G) |
| `NctVllm-Math` | Gemma 4 31B (g6e.12xlarge, 4×L40S) — gated |
| `NctVllm-Audio` | Phi-4 Multimodal (g5.xlarge, 1×A10G) |
| `NctVllm-Longcontext` | LLaMA 4 Scout 17B-16E (g6e.48xlarge, 8×L40S) — gated |
| `NctCertStack` | Self-signed wildcard cert `*.nct-gateway.internal` → ACM + Secrets Manager (CA) |
| `NctHigressStack` | Higress AI Gateway (EKS Helm) + Bedrock IAM user / consumer-key Secrets. Helm release + internal NLB 443은 `NctEksStack`에 렌더 |
| `NctSmartRouterStack` | SmartRouter ECS Fargate, Internal ALB 443 |
| `NctWarmupStack` | Step Functions (Warmup / Cooldown) |
| `NctReservationStack` | DynamoDB reservation + reserve/expire Lambda + EventBridge |
| `NctAdminConsoleStack` | FastAPI ECS + ALB (`admin.nct-gateway.internal`) |
| `NctDnsStack` | Route53 PHZ `nct-gateway.internal` + alias records |
| `NctTestClientStack` | in-VPC 테스트 EC2 (t3.small standard credit, SSM 전용) + Claude Code. 기본 포함, `-c deployTestClient=false`로 제외 |

</details>

<details>
<summary><strong>Warm-up / Reservation</strong> — 콜드 스타트 사전 기동, 자동 스케줄 (펼치기)</summary>

vLLM 모델은 미사용 시 `scale-to-zero` 상태입니다. 첫 요청 시 5~35분 콜드 스타트가 발생합니다. 사전에 warm-up 하려면 다음과 같이 합니다:

```bash
# 특정 alias 1시간 warm-up
scripts/warmup-request.sh --alias coding --requester andrew

# 복수 alias + 기간
scripts/warmup-request.sh --alias coding,math --duration 2h --requester andrew

# 전체 모델 30분
scripts/warmup-request.sh --alias all --duration 30m
```

- 예약은 DynamoDB `NctWarmupReservations`에 저장되고 → `reserve-fn`이 Warmup SFN을 트리거합니다.
- 만료 시 `expire-fn`이 Cooldown SFN을 트리거합니다 (겹치는 예약이 있으면 연장).
- **자동 스케줄**: 평일 08:30~19:30 KST, EventBridge rule로 모든 alias를 자동 warm-up합니다.
- **Admin Console**: `https://admin.nct-gateway.internal` — 현재 예약/상태 확인 및 수동 조작이 가능합니다.

</details>

<details>
<summary><strong>Admin Console</strong> — 운영자 콘솔 (replicas·예약·수동 스케일) (펼치기)</summary>

- URL: `https://admin.nct-gateway.internal` (내부망)
- 인증: Basic Auth — 비밀번호는 Secrets Manager `/nct/admin-console/password`
- 기능:
  - 현재 alias별 replicas / 노드 상태
  - Active reservations 목록 / 남은 시간
  - 수동 warm-up / cool-down
  - Gateway 로그 / Bedrock 호출 통계 (기본)

</details>

<details>
<summary><strong>NCT 요건 지원 체크리스트</strong> — 기술 통제 매핑 + CRIS 미사용 근거 (펼치기)</summary>

> ⚠️ 아래 기술 통제는 NCT 요건을 **지원**하는 것이지, 이 코드를 배포한다고 자동으로 규정을 "준수"하게 되는 것은 아닙니다. 실제 NCT 컴플라이언스는 조직의 정책·인력 접근통제·감사·법적 검토를 포함한 종합 판단이며, 반드시 자체 보안/법무 검토를 거쳐야 합니다.

| 요건 | 지원하는 기술 통제 |
|------|--------------------|
| 모든 추론 Seoul 리전 | `bin/nct-genai-gateway.ts` — region 하드코딩 |
| Bedrock IN_REGION only | `config/models.ts` BEDROCK_MODELS 전부 `ap-northeast-2` |
| Bedrock ON_DEMAND only | Provisioned Throughput / Cross-region Inference 미사용 |
| 연구원 네트워크 격리 | Internal ALB + Route53 PHZ, public endpoint 없음 |
| 데이터 in transit 암호화 | ACM + HTTPS 443 (self-signed wildcard cert) |
| 모델 가중치 격리 | S3 bucket 서울 리전, prefix per alias, 노드 IAM scope |
| AWS API egress | VPC Endpoints (S3/DDB/ECR/STS/SM) — NAT 우회 |

> **왜 Cross-Region Inference(CRIS)를 쓰지 않는가?** Bedrock에서 frontier 모델을 Seoul에서 호출하더라도, 그 모델이 in-region이 아니라 CRIS(geographic inference profile)로만 제공되면 추론 중 input prompt와 output이 같은 geography(예: APAC) 내 타 리전으로 전송됩니다 — 저장은 source 리전에만 남지만 **처리는 Seoul을 벗어납니다** ([AWS 문서](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html): *"your input prompts and output results might move outside of your source Region during cross-Region inference"*). 데이터의 국내 체류가 요건인 환경에서는 부적합합니다. 본 게이트웨이는 (1) Seoul **IN_REGION on-demand** Bedrock 모델만 사용하고, (2) 그 외에는 EKS 위 **self-host vLLM**으로 라우팅하여 추론이 Seoul을 벗어나지 않도록 강제합니다.

</details>

<details>
<summary><strong>Key Design Decisions</strong> — EKS Auto Mode·S3 Mountpoint·스마트 라우팅·Higress 변환·Pod Identity (펼치기)</summary>

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

</details>

<details>
<summary><strong>Cost Model</strong> — scale-to-zero ~$0.45/hr, 모델 기동 시 alias별 추가 (펼치기)</summary>

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
| 테스트 클라이언트 (기본 포함) | t3.small (standard credit) | \~$0.024 + EBS 20GB gp3 \~$0.002 |
| **상시 합계** | | **\~$0.47/hr (\~$340/month)** |

### vLLM 모델 기동 시 (alias 별)
| Alias | 인스턴스 | 시간당 추가 |
|-------|----------|-------------|
| coding / video / ocr | g5.12xlarge | ~$5.67 |
| math | g6e.12xlarge | ~$3.90 |
| audio | g5.xlarge | ~$1.00 |
| longcontext | g6e.48xlarge | ~$30.90 |

자동 스케줄(평일 08:30~19:30 KST, 11h × 21일) 기준 전체 warm-up 시 월 비용은 다음과 같습니다:
- coding + video + ocr + math + audio: \~$17/hr × 231h = \~$3,927
- + longcontext (필요 시만): +$30.90/hr × 사용시간

> 비용 최적화: `longcontext`는 예약(`--alias longcontext`)으로만 기동하고, 필요 없는 alias는 `minReplicas=0`으로 유지하십시오.
> 모든 가격은 작성 시점 개략 추정치입니다. 최신 요율은 [AWS Pricing Calculator](https://calculator.aws/)에서 확인하십시오.

</details>

<details>
<summary><strong>Operations</strong> — 수동 스케일·로그·헬스 체크 (펼치기)</summary>

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

</details>

<details>
<summary><strong>검증 결과 (Test Report)</strong> — E2E 4/4 PASS + 해결한 corner case 3종 (펼치기)</summary>

배포된 환경에서 게이트웨이 진입점(`gateway.nct-gateway.internal`, Anthropic Messages API `/v1/messages`, `x-api-key` 마스터 키)으로 in-VPC 클라이언트에서 실측한 결과입니다. 4개 핵심 경로가 모두 통과했고, 운영 중 발견한 corner case 3종을 해결했습니다.

> ⚠️ 아래는 특정 배포에서의 실측 스냅샷입니다. 모델 버전·벤치마크·지연 수치는 배포 환경·시점에 따라 달라질 수 있으니 **도입 전 자체 환경에서 재현**하십시오.

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

</details>

<details>
<summary><strong>Known Issues</strong> (펼치기)</summary>

| # | 이슈 | 상태 |
|---|------|------|
| I1 | Bottlerocket + EFS TLS mount 실패 | S3 Mountpoint로 우회 (운영 안정) |
| I8 | 연구원별 독립 API 키 미지원 | 단일 공유 마스터 키. 향후 Higress consumer key-auth(연구원별 consumer)로 분리 예정 |
| — | Bedrock 모델 EOL | Seoul IN_REGION 후속 모델로 alias 갱신 필요. EOL 일정은 Bedrock 콘솔에서 확인 |

</details>

---

## Cleanup

```bash
cdk destroy --all --force
```

- EKS Auto Mode 삭제에 ~15분이 걸립니다.
- S3 model-cache bucket은 RETAIN 정책으로 가중치가 보존됩니다.

---

## Related

- [vLLM 문서](https://docs.vllm.ai)
- [Higress 문서](https://higress.cn/en/docs/latest/overview/what-is-higress/)
- [Amazon EKS Auto Mode](https://docs.aws.amazon.com/eks/latest/userguide/automode.html)
- [Claude Code — LLM Gateway 설정](https://code.claude.com/docs/en/llm-gateway)
- [NCT 근거법 (산업기술의 유출방지 및 보호에 관한 법률)](https://www.law.go.kr/법령/산업기술의유출방지및보호에관한법률)
