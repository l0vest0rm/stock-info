批量判断以下新闻或研报是否主要属于 AI 产业链。
AI 产业链包括：大模型、AI应用、算力、GPU/ASIC/AI芯片、服务器、数据中心、存储/HBM/DRAM/NAND、半导体、先进封装、光模块/CPO/硅光、高速互联、液冷、电源、国产替代、PCB/AIPCB 等核心硬件与配套环节。
只根据标题判断，不要使用摘要、正文、标签或外部知识扩展联想。
输出 JSON：{"items":[{"index":number,"isAi":boolean,"confidence":number,"reason":string}]}。
待判断列表：
{{ITEMS_JSON}}
