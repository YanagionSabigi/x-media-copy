(function () {
  'use strict';
  const labels = { queued: '等待处理', converting: '正在转换 GIF', downloading: '浏览器下载中', complete: '下载完成', failed: '处理失败', cancelled: '已取消' };
  let interacting = false, last = '';
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || '无法连接扩展后台');
    return response.data;
  }
  function button(row, title, action) {
    const node = document.createElement('button'); node.textContent = title;
    node.onclick = async () => {
      interacting = true; node.disabled = true;
      try { await action(); document.getElementById('feedback').textContent = ''; }
      catch (error) { document.getElementById('feedback').textContent = error.message; }
      finally { interacting = false; node.disabled = false; last = ''; await refresh(); }
    };
    row.append(node);
  }
  async function refresh() {
    if (interacting) return;
    try {
      const jobs = await send({ type: 'getJobs' });
      const signature = JSON.stringify(jobs);
      if (signature === last) return;
      last = signature;
      const list = document.getElementById('jobs'); list.replaceChildren();
      if (!jobs.length) { list.textContent = '还没有媒体下载任务。'; return; }
      for (const job of jobs.slice().reverse()) {
        const row = document.createElement('div'); row.className = 'job';
        const heading = document.createElement('p'); heading.textContent = `${job.type === 'animated_gif' ? 'GIF' : '视频'} · ${job.postId} · ${labels[job.status] || job.status}`;
        row.append(heading);
        if (job.stage) { const stage = document.createElement('small'); stage.textContent = job.stage; row.append(stage); }
        if (job.error) { const error = document.createElement('p'); error.className = 'error'; error.textContent = job.error; row.append(error); }
        if (['queued', 'converting', 'downloading'].includes(job.status)) button(row, '取消', () => send({ type: 'cancelJob', jobId: job.id }));
        else if (job.status === 'failed' || job.status === 'cancelled') {
          button(row, '重试', () => send({ type: 'retryJob', jobId: job.id }));
          if (job.type === 'animated_gif' && job.url) button(row, '下载原始 MP4', () => send({ type: 'retryMp4', jobId: job.id }));
        }
        if (job.status === 'complete' && job.downloadId) button(row, '在文件夹中显示', () => chrome.downloads.show(job.downloadId));
        list.append(row);
      }
    } catch (error) { document.getElementById('feedback').textContent = error.message; }
  }
  void refresh(); setInterval(refresh, 1000);
})();
