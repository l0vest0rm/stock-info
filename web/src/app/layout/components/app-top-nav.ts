import { defineComponent, h } from "vue";
import { navConfig } from "../config/navigation";

function topNavClass(page: string, href: string): string {
  const stateClass = page === href ? "text-secondary active" : "text-white";
  return `nav-link px-2 ${stateClass}`;
}

export const AppTopNav = defineComponent({
  name: "AppTopNav",
  props: {
    page: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    return () =>
      h("header", { class: "p-0 bg-dark text-white" }, [
        h("div", { class: "container" }, [
          h("div", { class: "d-flex flex-wrap align-items-center justify-content-center" }, [
            h(
              "a",
              { href: "/", class: "d-flex align-items-center mb-4 mb-lg-0 text-white text-decoration-none" },
              [h("span", { class: "fs-4" }, "理财人tinfo.cc  |")]
            ),
            h(
              "ul",
              { class: "nav col-12 col-lg-auto me-lg-auto mb-2 justify-content-center mb-md-0" },
              navConfig.nav.map((item) =>
                h("li", { key: item.href }, [
                  h(
                    "a",
                    {
                      href: item.href,
                      class: topNavClass(props.page, item.href),
                      "aria-current": props.page === item.href ? "true" : undefined,
                    },
                    item.text
                  ),
                ])
              )
            ),
            h("form", { class: "col-12 col-lg-auto mb-3 mb-lg-0 me-lg-3 position-relative" }, [
              h("input", {
                id: "autocomplete",
                type: "search",
                autocomplete: "off",
                class: "form-control form-control-sm form-control-dark",
                placeholder: "Search...",
              }),
            ]),
          ]),
        ]),
      ]);
  },
});
