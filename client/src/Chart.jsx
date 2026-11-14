import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { sampleSeries } from './history.js';

export function Chart({
  points = [],
  metric = 't',
  color = '#f97316',
  height = 130,
  compact = false,
  label,
}) {
  const element = useRef(null),
    plot = useRef(null);
  const latest = useRef({ points, metric });
  latest.current = { points, metric };
  const update = () => {
    if (!plot.current) return;
    const rows = sampleSeries(
      latest.current.points.filter((p) => p.ts <= Date.now()),
      latest.current.metric,
    );
    plot.current.setData([rows.map((p) => p.ts / 1000), rows.map((p) => p[latest.current.metric])]);
  };
  useEffect(() => {
    const el = element.current;
    const make = (width) => {
      if (width < 20) return;
      if (plot.current) {
        plot.current.setSize({ width, height });
        return;
      }
      plot.current = new uPlot(
        {
          width,
          height,
          padding: compact ? [4, 0, 3, 0] : [10, 9, 0, 0],
          cursor: { show: !compact },
          legend: { show: false },
          scales: { x: { time: true }, y: { auto: true } },
          axes: compact
            ? [{ show: false }, { show: false }]
            : [
                {
                  stroke: '#909099',
                  grid: { show: false },
                  ticks: { show: false },
                  font: '10px system-ui',
                  size: 26,
                },
                {
                  stroke: '#909099',
                  grid: { stroke: '#27272b', width: 1 },
                  ticks: { show: false },
                  font: '10px system-ui',
                  size: 34,
                },
              ],
          series: [
            {},
            {
              label: label || metric,
              stroke: color,
              width: 1.8,
              fill: `${color}0a`,
              points: { show: false },
              spanGaps: false,
            },
          ],
        },
        [[], []],
        el,
      );
      update();
    };
    const observer = new ResizeObserver(([entry]) => make(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    make(Math.floor(el.getBoundingClientRect().width));
    return () => {
      observer.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [color, height, compact, label, metric]);
  useEffect(update, [points, metric]);
  return (
    <div
      ref={element}
      className="chart"
      style={{ minHeight: height }}
      role="img"
      aria-label={label || `${metric} history`}
    />
  );
}
