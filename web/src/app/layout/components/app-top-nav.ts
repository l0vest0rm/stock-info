import { defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  loadSecuritySearchHistory,
  rememberSecuritySearch,
  type SecuritySearchHistoryItem,
} from "../../../platform/search-history";
import { navConfig } from "../config/navigation";
import { routeForSecuritySearch } from "../security-search-route";

type SearchResult = SecuritySearchHistoryItem;

function isHomePage(page: string): boolean {
  return page === "home.html" || page === "/" || page === "";
}

function topNavClass(page: string, href: string): string {
  const active = href === "/" ? isHomePage(page) : page === href;
  const stateClass = active ? "text-secondary active" : "text-white";
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
    const query = ref("");
    const suggestions = ref<SearchResult[]>([]);
    const searching = ref(false);
    const open = ref(false);
    const showingHistory = ref(false);
    const history = ref<SearchResult[]>(loadSecuritySearchHistory());
    const searchForm = ref<HTMLElement | null>(null);
    let currentRequestId = 0;
    let searchTimer = 0;

    const searchNow = async (raw: string) => {
      const trimmed = raw.trim();
      currentRequestId += 1;
      const requestId = currentRequestId;
      if (!trimmed) {
        history.value = loadSecuritySearchHistory();
        suggestions.value = history.value;
        searching.value = false;
        showingHistory.value = true;
        open.value = history.value.length > 0;
        return;
      }
      showingHistory.value = false;
      searching.value = true;
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
        const payload = await response.json();
        if (requestId !== currentRequestId) {
          return;
        }
        suggestions.value = Array.isArray(payload?.data) ? (payload.data as SearchResult[]) : [];
        open.value = true;
      } catch {
        if (requestId !== currentRequestId) {
          return;
        }
        suggestions.value = [];
        open.value = true;
      } finally {
        if (requestId === currentRequestId) {
          searching.value = false;
        }
      }
    };

    watch(query, (value) => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        void searchNow(value);
      }, 220);
    });

    const closeSearchOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !searchForm.value?.contains(event.target)) {
        open.value = false;
      }
    };

    onMounted(() => {
      document.addEventListener("click", closeSearchOnOutsideClick);
    });

    onBeforeUnmount(() => {
      window.clearTimeout(searchTimer);
      document.removeEventListener("click", closeSearchOnOutsideClick);
    });

    const rememberResult = (item: SearchResult) => {
      history.value = rememberSecuritySearch(item);
    };

    const openResult = (item: SearchResult) => {
      rememberResult(item);
      window.location.href = routeForSecuritySearch(item);
    };

    const onSubmit = (event: Event) => {
      event.preventDefault();
      const first = suggestions.value[0];
      if (first) {
        openResult(first);
      } else if (query.value.trim()) {
        void searchNow(query.value);
      }
    };

    return () =>
      h("header", { class: "p-0 bg-dark text-white" }, [
        h("div", { class: "container" }, [
          h("div", { class: "d-flex flex-wrap align-items-center justify-content-center py-2" }, [
            h(
              "a",
              { href: "/", class: "d-flex align-items-center mb-3 mb-lg-0 me-lg-3 text-white text-decoration-none" },
              [h("span", { class: "fs-4 fw-semibold" }, "投研社")]
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
            h("form", {
              ref: searchForm,
              class: "col-12 col-lg-auto mb-3 mb-lg-0 me-lg-3 position-relative",
              style: "width: min(18rem, 100%);",
              onSubmit,
            }, [
              h("input", {
                id: "autocomplete",
                type: "search",
                autocomplete: "off",
                class: "form-control form-control-sm form-control-dark",
                placeholder: "搜索代码或名称",
                value: query.value,
                onInput: (event: Event) => {
                  query.value = (event.target as HTMLInputElement).value;
                },
                onFocus: () => {
                  if (!query.value.trim()) {
                    history.value = loadSecuritySearchHistory();
                    suggestions.value = history.value;
                    showingHistory.value = true;
                  }
                  if (suggestions.value.length > 0) {
                    open.value = true;
                  }
                },
                onKeydown: (event: KeyboardEvent) => {
                  if (event.key === "Escape") {
                    open.value = false;
                  }
                },
              }),
              open.value
                ? h(
                    "div",
                    {
                      class: "list-group position-absolute start-0 end-0 top-100 z-3 mt-1 shadow-sm",
                      style: "max-height: 24rem; overflow-y: auto;",
                    },
                    suggestions.value.length > 0
                      ? [
                          showingHistory.value
                            ? h("div", { class: "list-group-item small text-muted py-2" }, "最近搜索")
                            : null,
                          ...suggestions.value.map((item) =>
                          h(
                            "button",
                            {
                              key: item.code,
                              type: "button",
                              class: "list-group-item list-group-item-action text-start d-flex align-items-center justify-content-between gap-3",
                              onClick: () => openResult(item),
                            },
                            [
                              h("span", { class: "fw-semibold" }, item.name),
                              h("span", { class: "small text-muted flex-shrink-0" }, item.code),
                            ]
                          )
                        ),
                        ]
                      : [
                          h(
                            "div",
                            { class: "list-group-item small text-muted" },
                            searching.value ? "搜索中..." : "没有找到匹配结果"
                          ),
                        ]
                  )
                : null,
            ]),
          ]),
        ]),
      ]);
  },
});
