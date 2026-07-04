import { defineComponent, h } from "vue";

export const CompanyInfoBar = defineComponent({
  name: "CompanyInfoBar",
  setup() {
    const metricItem = (label: string | null, content: unknown) =>
      h(
        "div",
        {
          class: [
            "company-info-strip-metric",
            label ? "" : "company-info-strip-metric-compact",
          ],
        },
        [
          label
            ? h("span", { class: "company-info-strip-label" }, `${label}: `)
            : null,
          h("span", { class: "company-info-strip-value" }, content),
        ],
      );

    return () =>
      h("section", { class: "company-info-strip-wrap" }, [
        h(
          "style",
          `
            .company-info-strip {
              align-items: center;
              background: rgba(255, 255, 255, 0.86);
              border: 1px solid rgba(18, 58, 103, 0.12);
              border-radius: 1rem;
              box-shadow: 0 .5rem 1.2rem rgba(15, 23, 42, 0.05);
              display: flex;
              flex-wrap: nowrap;
              gap: .5rem 1rem;
              margin-bottom: .9rem;
              overflow-x: auto;
              padding: .75rem 1rem;
              scrollbar-width: thin;
            }

            .company-info-strip-title {
              color: #123a67;
              flex: 0 1 auto;
              font-size: 1.35rem;
              font-weight: 700;
              line-height: 1.2;
              margin-right: .5rem;
              white-space: nowrap;
            }

            .company-info-strip-metrics {
              align-items: center;
              display: flex;
              flex: 0 0 auto;
              flex-wrap: nowrap;
              gap: .45rem .9rem;
            }

            .company-info-strip-metric {
              align-items: baseline;
              display: inline-flex;
              gap: .2rem;
              min-height: 1.75rem;
            }

            .company-info-strip-metric-compact {
              gap: 0;
            }

            .company-info-strip-label {
              color: #66788a;
              font-size: .9rem;
              white-space: nowrap;
            }

            .company-info-strip-value {
              color: #123a67;
              font-size: 1rem;
              font-weight: 700;
              white-space: nowrap;
            }

            @media (max-width: 767.98px) {
              .company-info-strip {
                align-items: flex-start;
                border-radius: .9rem;
                flex-wrap: wrap;
                overflow-x: visible;
                padding: .7rem .85rem;
              }

              .company-info-strip-title {
                font-size: 1.2rem;
                margin-right: 0;
                width: 100%;
                white-space: normal;
              }

              .company-info-strip-metrics {
                flex: 1 1 100%;
                flex-wrap: wrap;
                gap: .35rem .75rem;
              }

              .company-info-strip-label,
              .company-info-strip-value {
                font-size: .88rem;
              }
            }
          `,
        ),
        h("div", { class: "company-info-strip" }, [
          h("div", { class: "company-info-strip-title", id: "codeName" }),
          h("div", { class: "company-info-strip-metrics" }, [
            metricItem("股价", h("span", { id: "currentPrice" })),
            metricItem("涨跌", h("span", { id: "priceChange" })),
            metricItem("今年涨跌", h("span", { id: "ytdPriceChange" })),
            metricItem("去年至今", h("span", { id: "last2NowPriceChange" })),
            metricItem("市值(亿)", h("span", { id: "marketCap" })),
            metricItem(null, h("span", { id: "stockValuation" })),
            metricItem("股息率", h("span", { id: "yield" })),
          ]),
        ]),
      ]);
  },
});
