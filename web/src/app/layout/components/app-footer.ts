import { defineComponent, h } from "vue";
import { navConfig } from "../config/navigation";

export const AppFooter = defineComponent({
  name: "AppFooter",
  setup() {
    return () =>
      h("div", { class: "container" }, [
        h("footer", { class: "row g-4 py-5 mt-5 border-top" }, [
          h("div", { class: "col-lg-5" }, [
            h("h5", { class: "mb-3" }, "理财人"),
            h("p", { class: "text-muted mb-2" }, "股票、基金、研报资讯研究入口。适合先收敛候选标的，再进入详细页面继续研究。"),
            h("p", { class: "small text-muted mb-0" }, "内容仅供研究参考，不构成投资建议。"),
          ]),
          h("div", { class: "col-sm-6 col-lg-3" }, [
            h("h5", { class: "mb-3" }, "站内入口"),
            h("ul", { class: "nav flex-column" }, [
              ...navConfig.nav.map((item) =>
                h("li", { class: "nav-item mb-2", key: item.href }, [
                  h("a", { href: item.href, class: "nav-link p-0 text-muted" }, item.text),
                ])
              ),
            ]),
          ]),
          h("div", { class: "col-sm-6 col-lg-4" }, [
            h("h5", { class: "mb-3" }, "说明"),
            h("ul", { class: "nav flex-column" }, [
              h("li", { class: "nav-item mb-2" }, [
                h("span", { class: "text-muted" }, "首页聚合常用入口与研究线索"),
              ]),
              h("li", { class: "nav-item mb-2" }, [
                h("span", { class: "text-muted" }, "研报资讯页更适合作为每天的内容入口"),
              ]),
            ]),
          ]),
        ]),
      ]);
  },
});
