/** Public default MCP discovery inventory verified against the pinned Bunqueue executable. */
export const MCP_CATEGORIES = [
  {
    name: 'Jobs',
    tools: [
      'add_job',
      'add_jobs_bulk',
      'get_job',
      'get_job_state',
      'get_job_result',
      'update_progress',
      'get_job_by_custom_id',
      'wait_for_job',
      'get_progress',
      'get_job_logs',
      'add_job_log',
      'clear_job_logs',
      'observe_job',
    ],
  },
  {
    name: 'Job management',
    tools: [
      'cancel_job',
      'promote_job',
      'update_job_data',
      'change_job_priority',
      'move_to_delayed',
      'discard_job',
      'change_delay',
    ],
  },
  {
    name: 'Consumption',
    tools: [
      'pull_job',
      'pull_job_batch',
      'ack_job',
      'ack_job_batch',
      'fail_job',
      'job_heartbeat',
      'job_heartbeat_batch',
      'extend_lock',
    ],
  },
  {
    name: 'Queues',
    tools: [
      'list_queues',
      'count_jobs',
      'get_jobs',
      'get_job_counts',
      'pause_queue',
      'resume_queue',
      'drain_queue',
      'obliterate_queue',
      'clean_queue',
      'is_paused',
      'get_counts_per_priority',
      'list_jobs_page',
    ],
  },
  {
    name: 'Dead letter queue',
    tools: ['get_dlq', 'get_dlq_stats', 'retry_dlq', 'purge_dlq', 'retry_completed'],
  },
  { name: 'Cron', tools: ['add_cron', 'list_crons', 'get_cron', 'delete_cron'] },
  {
    name: 'Flows',
    tools: ['get_children_values', 'add_flow', 'add_flow_chain', 'add_flow_bulk_then', 'get_flow'],
  },
  {
    name: 'Rate limits',
    tools: [
      'set_rate_limit',
      'clear_rate_limit',
      'set_concurrency',
      'clear_concurrency',
      'get_queue_limits',
    ],
  },
  {
    name: 'Webhooks',
    tools: ['add_webhook', 'remove_webhook', 'list_webhooks', 'set_webhook_enabled'],
  },
  {
    name: 'Workers',
    tools: ['register_worker', 'unregister_worker', 'worker_heartbeat', 'list_workers'],
  },
  { name: 'Handlers', tools: ['register_handler', 'unregister_handler', 'list_handlers'] },
  {
    name: 'Monitoring',
    tools: [
      'get_stats',
      'get_queue_stats',
      'get_storage_status',
      'get_per_queue_stats',
      'get_memory_stats',
      'get_prometheus_metrics',
      'compact_memory',
      'diagnose_queue',
      'get_capabilities',
    ],
  },
] as const;

export const MCP_TOOL_NAMES = MCP_CATEGORIES.flatMap((category) =>
  category.tools.map((name) => `bunqueue_${name}`)
);
