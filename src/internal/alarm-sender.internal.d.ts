/** 专有构建注入实现的编译期声明；运行时代码不在开源仓库。 */
export declare function sendAlarm(topic: string, data: Record<string, unknown>): void;
/** 专有构建必须提供的同步状态发送入口；具体网络行为由闭源实现决定。 */
export declare function sendStatus(topic: string, data: Record<string, unknown>): void;
