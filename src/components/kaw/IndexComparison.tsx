import { Card } from "@/components/ui/card";
import { PortfolioBenchmarkChart } from "@/components/kaw/PortfolioBenchmarkChart";

/**
 * 지수비교 전체화면 (내부 도구 — 사이드바에 노출되지 않고 설정 → 내부 도구에서 연다).
 *
 * 계산과 차트는 대시보드의 "내 포트폴리오 vs 시장" 섹션과 **같은 공용 컴포넌트**
 * (`PortfolioBenchmarkChart`)를 쓴다. 표현만 full 로 다르다 — 중복 계산·중복 hook 을 만들지 않는다.
 */
export function IndexComparison() {
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold">지수비교</h2>
        <p className="text-sm text-muted-foreground mt-1">
          내 계좌(커스텀 운용) vs 초기 납입 시점부터 쭉 케이올웨더 성장형으로 운용했을 경우 비교
        </p>
      </div>

      <Card className="p-4 md:p-5">
        <PortfolioBenchmarkChart presentation="full" />
      </Card>
    </div>
  );
}
