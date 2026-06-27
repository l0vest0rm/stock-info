import { defineComponent, h } from "vue";

export const AppFooter = defineComponent({
  name: "AppFooter",
  setup() {
    return () =>
      h("div", { class: "container" }, [
        h("footer", { class: "row row-cols-5 py-5 my-5 border-top" }, [
          h("div", { class: "col" }),
          h("div", { class: "col" }, [
            h("h5", "Section"),
            h("ul", { class: "nav flex-column" }, [
              h("li", { class: "nav-item mb-2" }, [
                h("a", { href: "#", class: "nav-link p-0 text-muted" }, "Home"),
              ]),
            ]),
          ]),
        ]),
      ]);
  },
});
