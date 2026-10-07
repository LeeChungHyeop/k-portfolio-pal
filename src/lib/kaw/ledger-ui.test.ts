// 거래 이력 화면의 표시 규칙을 고정한다.
//
// 가장 중요한 것: **없는 값을 0 으로 바꾸지 않는다.** 증권사가 수수료·세금·거래후잔고를
// 주지 않는 계좌가 있어서, 0 원과 "모름"을 구분하지 않으면 사용자가 잘못 읽는다.
import { describe, it, expect } from "vitest";
import {
  dateConfidenceOf, eventDateConfidence, eventTypeLabel, topEtfLabel, eventDateLabel,
  fmtAmount, fmtNullableAmount, fmtQty, fmtDelta, fmtAuditTime,
  auditActionLabel, correctedFieldLabel, EVENT_TYPE_OPTIONS, SUGGESTED_TAGS,
} from "./ledger-ui";
import type { ResolvedEvent } from "./ledger";

const baseEvent = (patch: Partial<ResolvedEvent> = {}): ResolvedEvent => ({
  id: "rev:isa:2026-01-05", accountId: "isa", date: "2026-01-05", dateEnd: "2026-01-05",
  type: "rebalance", strategyIncluded: true, memo: "", tags: [], hidden: false,
  isUserCreated: false, regrouped: false, dateEvidence: ["broker-order-date"],
  lines: [], tradeCount: 0, buyCount: 0, sellCount: 0, buyAmount: 0, sellAmount: 0,
  netAmount: 0, preHoldings: {}, postHoldings: {}, topEtfNames: [],
  ...patch,
});

describe("없는 값을 추정해 채우지 않는다", () => {
  it("null / undefined 금액은 0 이 아니라 '—' 다", () => {
    expect(fmtNullableAmount(null)).toBe("—");
    expect(fmtNullableAmount(undefined)).toBe("—");
  });

  it("실제 0 원은 '0' 으로 보여준다 (모름과 구분한다)", () => {
    expect(fmtNullableAmount(0)).toBe("0");
  });

  it("값이 있으면 천단위로 보여준다", () => {
    expect(fmtNullableAmount(14_050)).toBe("14,050");
    expect(fmtAmount(1_013_210)).toBe("1,013,210");
  });
});

describe("수량 표기", () => {
  it("정수는 그대로, 소수는 필요한 자리까지", () => {
    expect(fmtQty(28)).toBe("28");
    expect(fmtQty(1234)).toBe("1,234");
    expect(fmtQty(1.5)).toBe("1.5");
  });

  it("매매 수량은 부호를 분명히 한다", () => {
    expect(fmtDelta(28)).toBe("+28");
    expect(fmtDelta(-40)).toBe("−40");
    expect(fmtDelta(0)).toBe("0");
  });
});

describe("날짜 신뢰도 — 추정을 확정처럼 보여주지 않는다", () => {
  it("증권사 주문일만 '확정' 이다", () => {
    const c = dateConfidenceOf("broker-order-date");
    expect(c.direct).toBe(true);
    expect(c.label).toBe("확정");
  });

  it("T+2 역산과 결제일 교차대조는 '추정' 이다", () => {
    expect(dateConfidenceOf("tplus2-weekday-inference").direct).toBe(false);
    expect(dateConfidenceOf("cross-account-settlement-match").direct).toBe(false);
  });

  it("모르는 근거는 확정이라고 말하지 않는다", () => {
    const c = dateConfidenceOf("some-future-source");
    expect(c.direct).toBe(false);
    expect(c.label).toBe("추정");
    expect(c.detail).toContain("some-future-source");
  });

  it("이벤트는 하나라도 추정이 섞이면 추정으로 본다", () => {
    expect(eventDateConfidence(baseEvent()).direct).toBe(true);
    const mixed = baseEvent({
      dateEvidence: ["broker-order-date", "tplus2-weekday-inference"],
    });
    expect(eventDateConfidence(mixed).direct).toBe(false);
    expect(eventDateConfidence(mixed).label).toBe("추정 포함");
  });

  it("근거가 하나도 없으면 확정이라고 하지 않는다", () => {
    expect(eventDateConfidence(baseEvent({ dateEvidence: [] })).direct).toBe(false);
  });
});

describe("이벤트 유형 — 확장 가능하다", () => {
  it("아는 유형은 한글 라벨로", () => {
    expect(eventTypeLabel("rebalance")).toBe("리밸런싱");
    expect(eventTypeLabel("contribution_buy")).toBe("정기매수");
    expect(eventTypeLabel("pre_strategy_trade")).toBe("전략 이전 매매");
  });

  it("모르는 유형은 값을 그대로 보여주고 화면이 깨지지 않는다", () => {
    expect(eventTypeLabel("future_kind")).toBe("future_kind");
  });

  it("선택지와 추천 태그가 비어 있지 않다", () => {
    expect(EVENT_TYPE_OPTIONS).toContain("rebalance");
    expect(SUGGESTED_TAGS).toContain("정기매수");
  });
});

describe("목록 표시", () => {
  it("주요 종목은 2개까지 보여주고 나머지는 개수로", () => {
    expect(topEtfLabel(baseEvent({ topEtfNames: [] }))).toBe("—");
    expect(topEtfLabel(baseEvent({ topEtfNames: ["A"] }))).toBe("A");
    expect(topEtfLabel(baseEvent({ topEtfNames: ["A", "B"] }))).toBe("A, B");
    expect(topEtfLabel(baseEvent({ topEtfNames: ["A", "B", "C", "D"] }))).toBe("A, B 외 2");
  });

  it("병합해서 날짜 범위가 생기면 범위로 보여준다", () => {
    expect(eventDateLabel(baseEvent())).toBe("2026-01-05");
    expect(eventDateLabel(baseEvent({ dateEnd: "2026-03-09" })))
      .toBe("2026-01-05 ~ 26.03.09");
  });
});

describe("변경 이력 라벨", () => {
  it("분류 수정과 거래정보 정정을 다른 말로 보여준다", () => {
    expect(auditActionLabel("memo_change")).toBe("메모 수정");
    expect(auditActionLabel("event_merge")).toBe("이벤트 병합");
    expect(auditActionLabel("tx_correct")).toBe("거래정보 정정");
    expect(auditActionLabel("tx_uncorrect")).toBe("정정 취소(원본 복귀)");
  });

  it("모르는 action 은 값을 그대로 보여준다", () => {
    expect(auditActionLabel("future_action")).toBe("future_action");
  });

  it("정정 필드 이름을 사람 말로 바꾼다", () => {
    expect(correctedFieldLabel("quantity")).toBe("수량");
    expect(correctedFieldLabel("eventDate")).toBe("거래일");
    expect(correctedFieldLabel("unknown")).toBe("unknown");
  });

  it("변경 시각은 한국시간으로 보여준다", () => {
    // UTC 2026-01-05 00:30 → KST 09:30
    expect(fmtAuditTime("2026-01-05T00:30:00.000Z")).toBe("2026-01-05 09:30");
  });

  it("시각을 파싱할 수 없으면 원문을 그대로 둔다 (가짜 날짜를 만들지 않는다)", () => {
    expect(fmtAuditTime("not-a-date")).toBe("not-a-date");
  });
});
