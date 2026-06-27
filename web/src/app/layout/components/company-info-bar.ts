import { defineComponent, h } from "vue";

export const CompanyInfoBar = defineComponent({
  name: "CompanyInfoBar",
  setup() {
    return () =>
      h("div", { class: "text-center border my-2" }, [
        h("span", { class: "px-1 fs-5 fw-medium", id: "codeName" }),
        h("span", { class: "px-1" }, ["股价: ", h("span", { id: "currentPrice" })]),
        h("span", { class: "px-1" }, ["涨跌: ", h("span", { id: "priceChange" })]),
        h("span", { class: "px-1" }, ["今年涨跌: ", h("span", { id: "ytdPriceChange" })]),
        h("span", { class: "px-1" }, ["去年至今: ", h("span", { id: "last2NowPriceChange" })]),
        h("span", { class: "px-1" }, ["市值: ", h("span", { id: "marketCap" }), "(亿)"]),
        h("span", { id: "stockValuation" }),
        h("span", { class: "px-1", id: "yield" }),
      ]);
  },
});
