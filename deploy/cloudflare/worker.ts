// FinHot 在 Cloudflare Containers 上的 Worker 外壳。
//
// 这个 Worker 本身不干活，只做一件事：把 finhot.fun 收到的请求转给容器里的 web 进程
// （3000 端口）。网站的全部逻辑——SSR、API、抓取、模型调用——都跑在容器里那个真实的
// Linux 环境里，所以 sharp、Fastify、pg-boss、文件系统这些 Node 专有能力都不用改。
//
// 为什么不是 Workers：见 docs/deploy.md 与仓库根目录的迁移记录。简单说，改用 Workers 要把
// 图片处理、消息队列、118 条路由、文件存储等八个子系统重写一遍，约 200–320 人时，而且
// 备份（pg_dump）、排行榜求解、境外出口代理这三件事在 Workers 上根本做不了。
import { Container, getContainer } from "@cloudflare/containers";
import { containerEnvironment } from "./environment.ts";

// Env 由 `npx wrangler types` 生成到仓库根目录的 worker-configuration.d.ts，里面按
// wrangler.jsonc 的 durable_objects 绑定给出了 FINHOT。不要在这里另声明一个 Env：
// 模块内的同名接口会遮蔽全局的那个，导致 Container<Env> 与 getContainer 的约束不匹配。
export class FinHotContainer extends Container<Env> {
	// Explicitly forward vars/secrets; binding objects and unrelated credentials stay in the Worker.
	envVars = containerEnvironment(this.env);
	entrypoint = ["/bin/bash", "/app/deploy/cloudflare/entrypoint.sh"];
	/** 容器里 web 进程监听的端口（apps/web/server.ts 默认 3000）。 */
	defaultPort = 3000;

	/**
	 * 空闲多久后容器休眠。
	 *
	 * 注意这个超时只看**经过 Worker 转发的 HTTP 请求**，容器内部 worker 进程的信源轮询
	 * 不算数。也就是说：没人访问站点满 30 分钟后，容器会休眠，抓取和模型任务同时停止。
	 *
	 * wrangler.jsonc 的五分钟 Cron 在采集开启时访问健康检查，保持后台任务运行。
	 * 采集关闭时不保活，仍允许容器空闲休眠。
	 */
	sleepAfter = "30m";

	/** 容器要出网：抓信源、调模型接口都得访问外网。 */
	enableInternet = true;

	override onStart() {
		console.log("[finhot] 容器已启动");
	}

	override onStop() {
		console.log("[finhot] 容器已停止");
	}

	override onError(error: unknown) {
		console.error("[finhot] 容器出错:", error);
	}
}

export default {
	async scheduled(_event: ScheduledController, env: Env): Promise<void> {
		if (env.COLLECT_ENABLED !== "true") return;
		const response = await getContainer(env.FINHOT, "finhot-1").fetch(new Request("http://container/api/health"));
		if (!response.ok) throw new Error(`FinHot health check failed: HTTP ${response.status}`);
		await response.body?.cancel();
	},
	async fetch(request: Request, env: Env): Promise<Response> {
		// 固定用同一个实例 id：这是一个单实例应用，数据库是共享的，多开实例没有意义，
		// 反而会让内存里的缓存和限流计数各算各的。
		const container = getContainer(env.FINHOT, "finhot-1");
		return container.fetch(request);
	},
};
