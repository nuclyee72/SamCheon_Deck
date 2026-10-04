/**
 * 셀렉트박스(*) 선택지 목록 — 덱 보드의 모든 셀렉트가 여기서 선택지를 가져온다.
 *
 * ⚠️ 전형(formations)·병법(arts)·속성치(statOptions)를 뺀 나머지 목록은 전부 "예시" 값이다. 실제 게임 데이터로 바꿔 넣으면 된다.
 *
 * - 덱에는 name이 아니라 id가 저장된다. 그래서 name은 언제든 고쳐도 기존 덱이 안 깨진다.
 *   id를 바꾸거나 항목을 지우면, 그 값을 쓰던 덱의 셀렉트에는 "(삭제된 항목: id)"로 표시되고
 *   값은 그대로 남는다(다시 골라주면 됨).
 * - 목록 순서 = 셀렉트에 보이는 순서.
 * - 장비/탈것 옵션의 opt1/opt2는 각각 "1옵 후보", "2옵 후보" 목록이다(id는 두 목록을 통틀어 겹치지 않게).
 */
export const CATALOG = {
  /** 전형 */
  formations: [
    { id: "f-line", name: "일자진" },
    { id: "f-gi", name: "기형진" },
    { id: "f-goose", name: "안형진" },
    { id: "f-square", name: "방원진" },
    { id: "f-awl", name: "추형진" },
    { id: "f-fish", name: "어린진" },
    { id: "f-gu", name: "구행진" },
    { id: "f-moon", name: "언월진" },
  ],

  /** 병종 — short는 덱 이름 오른쪽에 자동으로 붙는 병종 요약 글자(장수 1·2·3 순서로 "말•창•활"). */
  troopTypes: [
    { id: "t-cavalry", name: "기병", short: "말" },
    { id: "t-spear", name: "창병", short: "창" },
    { id: "t-archer", name: "궁병", short: "활" },
    { id: "t-shield", name: "방패병", short: "방" },
  ],

  /** 병종 전통 — 지금은 병종과 무관하게 전체 목록이 보인다. */
  troopTraditions: [
    { id: "tr-elite", name: "정예 전통" },
    { id: "tr-heavy", name: "중장 전통" },
    { id: "tr-light", name: "경장 전통" },
  ],

  /** 병법 — 장수당 3개. 목록 맨 아래에 "고유"가 따로 붙고, 고르면 이름을 직접 입력하는 칸이 열린다. */
  arts: [
    { id: "a-01", name: "기동" },
    { id: "a-02", name: "귀모" },
    { id: "a-03", name: "여심" },
    { id: "a-04", name: "임시" },
    { id: "a-05", name: "피험" },
    { id: "a-06", name: "병정" },
    { id: "a-07", name: "수세" },
    { id: "a-08", name: "수토" },
    { id: "a-09", name: "기예" },
    { id: "a-10", name: "금고" },
    { id: "a-11", name: "승민" },
    { id: "a-12", name: "합전" },
    { id: "a-13", name: "선전" },
    { id: "a-14", name: "모전" },
    { id: "a-15", name: "연지" },
    { id: "a-16", name: "근선" },
    { id: "a-17", name: "병교" },
    { id: "a-18", name: "적용" },
    { id: "a-19", name: "적모" },
    { id: "a-20", name: "합모" },
    { id: "a-21", name: "선용" },
    { id: "a-22", name: "위수" },
    { id: "a-23", name: "임봉" },
    { id: "a-24", name: "대파" },
    { id: "a-25", name: "절봉" },
    { id: "a-26", name: "선위" },
    { id: "a-27", name: "선지" },
    { id: "a-28", name: "비전" },
    { id: "a-29", name: "정시" },
    { id: "a-30", name: "피용" },
    { id: "a-31", name: "겁지" },
    { id: "a-32", name: "연사" },
  ],

  /** 장비 옵션 — 1옵에 붙을 수 있는 후보(opt1)와 2옵 후보(opt2)가 따로 있다. 덱에서는 각 옵마다
   * 이 후보 중 추천을 개수 제한 없이 고른다(왼쪽부터 추천 순서). */
  equipmentOptions: {
    opt1: [
      { id: "eo1-atk", name: "공격력" },
      { id: "eo1-str", name: "무력" },
      { id: "eo1-int", name: "지력" },
      { id: "eo1-crit", name: "치명" },
    ],
    opt2: [
      { id: "eo2-def", name: "방어" },
      { id: "eo2-hp", name: "병력" },
      { id: "eo2-dodge", name: "회피" },
      { id: "eo2-heal", name: "회복량" },
    ],
  },

  /** 탈것 옵션 — 장비와 같은 형식(opt1 / opt2 후보가 따로). */
  mountOptions: {
    opt1: [
      { id: "mo1-speed", name: "속도" },
      { id: "mo1-lead", name: "통솔" },
      { id: "mo1-first", name: "선공" },
    ],
    opt2: [
      { id: "mo2-dodge", name: "회피" },
      { id: "mo2-reduce", name: "피해감소" },
      { id: "mo2-morale", name: "사기" },
    ],
  },

  /** 관계 템플릿 — 덱끼리 잇는 관계선의 종류. 툴바 "관계 ▾"에 이 순서대로 나온다. 여기 항목을 더
   * 추가하면 새 관계 종류가 생긴다. arrow: 화살표(시작 덱 → 끝 덱) 여부, label/color/lineStyle은
   * 새로 그을 때의 기본값(그은 뒤 선을 눌러 바꿀 수 있음). lineStyle: "solid" | "dashed" | "dotted". */
  relationTemplates: [
    { id: "counter", name: "카운터", arrow: true, label: "카운터", color: "#d64545", lineStyle: "solid" },
    { id: "arrow", name: "화살표", arrow: true, label: "", color: null, lineStyle: "solid" },
    { id: "line", name: "기타(선)", arrow: false, label: "", color: null, lineStyle: "dashed" },
  ],

  /** 속성치 — 이 중 하나를 고른다(목록 맨 아래 "텍스트박스"를 고르면 직접 입력 칸이 열림). */
  statOptions: [
    { id: "s-str", name: "무력" },
    { id: "s-int", name: "지력" },
    { id: "s-lead", name: "통솔" },
    { id: "s-first", name: "선공" },
  ],
};
