/**
 * 필드(사각형 컨테이너)끼리의 겹침 판정과 정렬 스냅 — 가계도(TreeRenderer)와 덱 보드
 * (deck/src/view/DeckRenderer.js)가 같이 쓰는 순수 함수. rects는 {id, x, y, width, height}를
 * 내놓는 iterable(예: Map.values())이면 되고, x/y는 왼쪽 위 모서리(월드 좌표)다.
 */

/** (x,y,width,height) 사각형이 excludeIds에 없는 rects 중 하나와라도 겹치면 true — 축 정렬
 * 사각형(AABB) 겹침 검사. 경계선이 딱 맞닿기만 한 경우(끝점이 같음)는 겹친 것으로 안 쳐서
 * 필드끼리 서로 붙여둘 수 있게 한다. */
export function rectCollides(rects, width, height, x, y, excludeIds) {
  for (const other of rects) {
    if (excludeIds?.has(other.id)) continue;
    const overlapX = x < other.x + other.width && x + width > other.x;
    const overlapY = y < other.y + other.height && y + height > other.y;
    if (overlapX && overlapY) return true;
  }
  return false;
}

/**
 * rect를 (rawX, rawY)로 옮기려 할 때 다른 rects와 "클리핑"(정렬 스냅)되는 위치를 구한다 —
 * 같은 종류의 기준선끼리(왼쪽↔왼쪽/오른쪽↔오른쪽/가로 중간↔가로 중간, 위/아래/세로 중간도
 * 마찬가지) 맞추고, colSpacing/rowSpacing을 주면 "상대 중심에서 그만큼 떨어진 중심"(표준 칸
 * 간격)에도 스냅한다. threshold는 월드 좌표 기준(호출자가 화면 px / camera.scale로 넘김).
 * excludeIds: 그룹 드래그 중 같이 끌려가는 다른 필드처럼 후보로 부적절한 것.
 * 반환: { x, y, guideX, guideY, extraGuides } — guideX/Y는 정렬선 위치(없으면 null),
 * extraGuides는 칸 간격 스냅일 때 기준점에서 내 중심까지의 ㄱ자 안내선 토막들.
 */
export function computeRectSnap(rects, rawX, rawY, rect, { threshold, colSpacing = null, rowSpacing = null, excludeIds = null }) {
  const w = rect.width;
  const h = rect.height;

  let bestX = null, bestXDist = threshold, guideX = null, bestXAnchor = null;
  let bestY = null, bestYDist = threshold, guideY = null, bestYAnchor = null;

  const myXs = [rawX, rawX + w, rawX + w / 2];
  const myYs = [rawY, rawY + h, rawY + h / 2];
  const myCenterX = rawX + w / 2;
  const myCenterY = rawY + h / 2;

  for (const other of rects) {
    if (other.id === rect.id || excludeIds?.has(other.id)) continue;
    const theirXs = [other.x, other.x + other.width, other.x + other.width / 2];
    const theirYs = [other.y, other.y + other.height, other.y + other.height / 2];

    for (let i = 0; i < 3; i++) {
      const dx = theirXs[i] - myXs[i];
      if (Math.abs(dx) < bestXDist) {
        bestXDist = Math.abs(dx);
        bestX = rawX + dx;
        guideX = theirXs[i];
        bestXAnchor = null;
      }
      const dy = theirYs[i] - myYs[i];
      if (Math.abs(dy) < bestYDist) {
        bestYDist = Math.abs(dy);
        bestY = rawY + dy;
        guideY = theirYs[i];
        bestYAnchor = null;
      }
    }

    const theirCenterX = other.x + other.width / 2;
    const theirCenterY = other.y + other.height / 2;
    const anchor = { x: theirCenterX, y: theirCenterY };
    if (colSpacing) {
      for (const targetCenterX of [theirCenterX + colSpacing, theirCenterX - colSpacing]) {
        const dx = targetCenterX - myCenterX;
        if (Math.abs(dx) < bestXDist) {
          bestXDist = Math.abs(dx);
          bestX = rawX + dx;
          guideX = null;
          bestXAnchor = anchor;
        }
      }
    }
    if (rowSpacing) {
      for (const targetCenterY of [theirCenterY + rowSpacing, theirCenterY - rowSpacing]) {
        const dy = targetCenterY - myCenterY;
        if (Math.abs(dy) < bestYDist) {
          bestYDist = Math.abs(dy);
          bestY = rawY + dy;
          guideY = null;
          bestYAnchor = anchor;
        }
      }
    }
  }

  const x = bestX !== null ? bestX : rawX;
  const y = bestY !== null ? bestY : rawY;

  const extraGuides = [];
  const myFinalCenterX = x + w / 2;
  const myFinalCenterY = y + h / 2;
  if (bestXAnchor) {
    extraGuides.push({ x1: bestXAnchor.x, y1: bestXAnchor.y, x2: myFinalCenterX, y2: bestXAnchor.y });
    extraGuides.push({ x1: myFinalCenterX, y1: bestXAnchor.y, x2: myFinalCenterX, y2: myFinalCenterY });
  }
  if (bestYAnchor && (!bestXAnchor || bestYAnchor.x !== bestXAnchor.x || bestYAnchor.y !== bestXAnchor.y)) {
    extraGuides.push({ x1: bestYAnchor.x, y1: bestYAnchor.y, x2: bestYAnchor.x, y2: myFinalCenterY });
    extraGuides.push({ x1: bestYAnchor.x, y1: myFinalCenterY, x2: myFinalCenterX, y2: myFinalCenterY });
  }

  return { x, y, guideX, guideY, extraGuides };
}

/** (x, y)에서 시작해 step 간격의 사각 링을 바깥으로 넓혀가며, rects와 안 겹치는 가장 가까운
 * 왼쪽 위 모서리 위치를 찾는다. 끝까지 못 찾으면 원래 위치를 그대로 돌려준다. */
export function findFreeRectSpot(rects, width, height, x, y, step = 40) {
  const list = [...rects];
  const isFree = (cx, cy) => !rectCollides(list, width, height, cx, cy, null);
  if (isFree(x, y)) return { x, y };
  for (let ring = 1; ring <= 100; ring++) {
    let best = null;
    let bestDist = Infinity;
    for (let i = -ring; i <= ring; i++) {
      for (const [gx, gy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
        const dist = gx * gx + gy * gy;
        if (dist < bestDist && isFree(x + gx * step, y + gy * step)) {
          best = { x: x + gx * step, y: y + gy * step };
          bestDist = dist;
        }
      }
    }
    if (best) return best;
  }
  return { x, y };
}
