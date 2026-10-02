/** 用 Redis 比较并交换事务保存权威房间，防止跨实例覆盖或重复结算。 */
import { RedisClientType } from 'redis';
import { Room } from './types';

type RedisConnection = RedisClientType;

const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
if not current then return -1 end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

/** 表示应向客户端明确返回的房间或规则错误。 */
export class RoomError extends Error {
  /**
   * 创建包含可公开错误消息的异常。
   * @param message 客户端可读的错误原因。
   * @returns 新的 RoomError。
   * @callers RoomStore；socketServer 的输入和身份校验。
   */
  constructor(message: string) {
    super(message);
    this.name = 'RoomError';
  }
}

export class RoomStore {
  /**
   * 绑定已有 Redis 连接及房间保存配置。
   * @param client 已连接且关闭离线命令队列的 Redis 客户端。
   * @param keyPrefix 此应用的 Redis 键前缀。
   * @param ttlSeconds 自最后一次成功事务起的房间生存时间。
   * @returns 房间存储实例。
   * @callers socketServer.setupSocketServer。
   */
  constructor(
    private readonly client: RedisConnection,
    private readonly keyPrefix: string,
    private readonly ttlSeconds: number,
  ) {}

  /**
   * 创建不存在的房间，不覆盖任何已有房间。
   * @param room 包含初始状态和服务器凭证哈希的房间。
   * @returns 创建成功为 true；ID 已占用为 false。
   * @throws Redis 连接或命令失败时拒绝。
   * @callers socketServer.handleCreateRoom。
   */
  async create(room: Room): Promise<boolean> {
    this.requireReady();
    const result = await this.client.set(this.key(room.id), JSON.stringify(room), {
      NX: true,
      EX: this.ttlSeconds,
    });
    return result === 'OK';
  }

  /**
   * 读取权威房间；不存在或过期时报告明确错误。
   * @param roomId 房间 ID。
   * @returns Redis 当前保存的完整服务器房间。
   * @throws RoomError 或 Redis 命令错误。
   * @callers 后端状态诊断。
   */
  async read(roomId: string): Promise<Room> {
    this.requireReady();
    const serialized = await this.client.get(this.key(roomId));
    if (serialized === null) throw new RoomError('房间不存在或已过期');
    return JSON.parse(serialized) as Room;
  }

  /**
   * 在唯一比较并交换入口更新房间，冲突后重新读取并重新校验规则。
   * 回调只能修改传入的房间，不得广播、写其他键或产生外部副作用。
   * 只有序列化状态变化才递增版本；无变化的认证查询只刷新空闲期限。
   * @param roomId 房间 ID。
   * @param mutate 同步验证并修改当前权威状态的回调。
   * @returns 最终成功提交的房间。
   * @throws 房间过期、规则校验失败、Redis 不可用或连续竞争超过 32 次。
   * @callers socketServer 的恢复、加入、行动、查询和断线处理。
   */
  async update(roomId: string, mutate: (room: Room) => void): Promise<Room> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      this.requireReady();
      const serialized = await this.client.get(this.key(roomId));
      if (serialized === null) throw new RoomError('房间不存在或已过期');
      const room = JSON.parse(serialized) as Room;
      mutate(room);
      if (JSON.stringify(room) !== serialized) {
        room.revision += 1;
        room.gameState.revision = room.revision;
      }
      const result = await this.client.eval(COMPARE_AND_SET, {
        keys: [this.key(roomId)],
        arguments: [serialized, JSON.stringify(room), String(this.ttlSeconds)],
      });
      if (result === 1) return room;
      if (result === -1) throw new RoomError('房间不存在或已过期');
    }
    throw new RoomError('房间操作竞争过多，请重新获取状态后重试');
  }

  /**
   * 生成应用隔离的房间键。
   * @param roomId 房间 ID。
   * @returns Redis 房间键。
   * @callers RoomStore.create；RoomStore.read；RoomStore.update。
   */
  private key(roomId: string): string {
    return `${this.keyPrefix}:room:${roomId}`;
  }

  /**
   * 阻止 Redis 断线时把操作排队并伪装成已接受。
   * @returns 无返回值。
   * @throws RoomError 当连接不处于可用状态。
   * @callers RoomStore.create；RoomStore.read；RoomStore.update。
   */
  private requireReady(): void {
    if (!this.client.isReady) throw new RoomError('房间存储不可用，请重新连接');
  }
}
