import { parentPort, workerData } from 'worker_threads'
import { wcdbService } from './services/wcdbService'
import { chatServiceCore } from './services/chatServiceCore'

interface RelationStatsWorkerConfig {
  sessionIds: string[]
  options: {
    includeRelations?: boolean
    forceRefresh?: boolean
    allowStaleCache?: boolean
    preferAccurateSpecialTypes?: boolean
    cacheOnly?: boolean
  }
  dbPath?: string
  decryptKey?: string
  myWxid?: string
  resourcesPath?: string
  userDataPath?: string
  logEnabled?: boolean
}

const config = workerData as RelationStatsWorkerConfig
process.env.CHATFLOW_WORKER = '1'
if (config.resourcesPath) {
  process.env.WCDB_RESOURCES_PATH = config.resourcesPath
}
if (config.userDataPath) {
  process.env.CHATFLOW_USER_DATA_PATH = config.userDataPath
  process.env.CHATFLOW_CONFIG_CWD = config.userDataPath
}
process.env.CHATFLOW_PROJECT_NAME = process.env.CHATFLOW_PROJECT_NAME || 'ChatFlow'

async function run() {
  try {
    // 设置服务
    wcdbService.setPaths(config.resourcesPath || '', config.userDataPath || '')
    wcdbService.setLogEnabled(config.logEnabled === true)

    // 设置聊天服务配置
    chatServiceCore.setRuntimeConfig({
      dbPath: config.dbPath,
      decryptKey: config.decryptKey,
      myWxid: config.myWxid
    })

    // 发送进度消息
    parentPort?.postMessage({
      type: 'progress',
      data: { stage: 'connecting', message: '正在连接数据库...' }
    })

    const connectResult = await chatServiceCore.ensureConnected()
    if (!connectResult.success) {
      parentPort?.postMessage({
        type: 'error',
        error: connectResult.error || '数据库连接失败'
      })
      return
    }

    parentPort?.postMessage({
      type: 'progress',
      data: { stage: 'querying', message: '正在查询关系统计...' }
    })

    const result = await chatServiceCore.getExportSessionStats(
      config.sessionIds,
      config.options
    )

    parentPort?.postMessage({
      type: 'result',
      data: result
    })
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      error: String(error)
    })
  }
}

run().catch((error) => {
  parentPort?.postMessage({
    type: 'error',
    error: String(error)
  })
})
