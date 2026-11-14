// Compact wire format for zone frames. Instead of sending objects with field
// names for every sensor on every tick, the server sends a sensor table once
// and then only rows for sensors that changed since the previous tick:
//
//   [index, seq, temp*10, humidity, smoke, fdi, status, ts-offset]
//
// All values are integers, which keeps JSON short and parsing fast.

export const ROW = { IDX: 0, SEQ: 1, T: 2, H: 3, S: 4, FDI: 5, STATUS: 6, DT: 7 };

export function encodeRow(idx, st, frameTs) {
  return [
    idx,
    st.seq,
    st.t == null ? null : Math.round(st.t * 10),
    st.h == null ? null : Math.round(st.h),
    st.s == null ? null : Math.round(st.s),
    st.fdi ?? 0,
    st.status ?? 0,
    frameTs - st.ts,
  ];
}

export function decodeRow(row, frameTs) {
  return {
    idx: row[ROW.IDX],
    seq: row[ROW.SEQ],
    t: row[ROW.T] == null ? null : row[ROW.T] / 10,
    h: row[ROW.H],
    s: row[ROW.S],
    fdi: row[ROW.FDI],
    status: row[ROW.STATUS],
    ts: frameTs - row[ROW.DT],
  };
}
