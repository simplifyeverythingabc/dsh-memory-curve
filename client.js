/**
 * dsh-memory-curve 的前端部分。
 *
 * 往设置面板的 `settings.section` 插槽注册一个页面，让用户能在 GUI 里填
 * 「完整记忆存放目录」，而不是去手改 profile 的 cordis.patch.yml。
 *
 * 页面通过共享的 `configForms` 服务读写 Loader entry（`memory-curve`）——
 * 和 DSH 自带设置页走同一条路。整个模块套在守卫里：拿不到 Loader、插槽或
 * 服务时安静退出，不影响别的页面。
 *
 * @module dsh-memory-curve/client
 */
(function () {
  'use strict';

  /** 记日志但不能让日志本身抛错。 */
  function warn(error) {
    try {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[memory-curve] client:', error);
      }
    } catch (ignored) {
      /* 吞掉 */
    }
  }

  try {
    if (typeof window === 'undefined') return;
    var loader = window.__ModuleLoader__;
    if (loader === null || typeof loader !== 'object' || typeof loader.load !== 'function') return;

    loader.load({
      id: 'dsh-memory-curve',
      factory: function (require) {
        try {
          var React = require('react');
          var h = React.createElement;

          /** 设置面板的插槽名：一个条目一页。 */
          var SLOT = 'settings.section';
          /** Loader entry id —— 必须和 cordis.patch.yml 里的 `id` 一致。 */
          var ENTRY = 'memory-curve';
          /**
           * configForms 里的命名空间候选，按精确程度排序。
           * Host 投影出来的通常是 include:<entry id>；裸 id 和包名也试一下。
           */
          var NAMESPACES = ['include:' + ENTRY, ENTRY, 'dsh-memory-curve'];
          /** React 18 的 external-store hook，带回退。 */
          var useSync = typeof React.useSyncExternalStore === 'function'
            ? React.useSyncExternalStore
            : function (subscribe, getSnapshot) {
                var pair = React.useState(getSnapshot);
                React.useEffect(function () {
                  return subscribe(function () { pair[1](getSnapshot()); });
                }, [subscribe, getSnapshot]);
                return pair[0];
              };

          var EMPTY = { status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: 0, writable: false, error: undefined };
          function emptySnapshot() { return EMPTY; }

          /** 部署环境有没有 configForms 服务。 */
          function hasFormService(ctx) {
            var forms = ctx === undefined || ctx === null ? undefined : ctx.configForms;
            return forms !== undefined && forms !== null && typeof forms.get === 'function';
          }

          /**
           * 从 settings mirror 里取本插件的 descriptor。
           *
           * 实测 form 对象可能是空的（getSnapshot 一直返回 status=unavailable），
           * 但 mirror 里一直有完整数据：schema / value / base / user / revision。
           * 直接读它更可靠。
           */
          function readDescriptor(ctx) {
            try {
              var forms = ctx === undefined || ctx === null ? undefined : ctx.configForms;
              var m = forms === undefined || forms === null ? undefined : forms.mirror;
              if (m === undefined || m === null || typeof m.getSnapshot !== 'function') return null;
              var snap = m.getSnapshot();
              var view = snap === undefined || snap === null ? undefined : snap.view;
              var list = view === undefined || view === null || !Array.isArray(view.namespaces) ? [] : view.namespaces;
              for (var i = 0; i < list.length; i += 1) {
                var d = list[i];
                if (d && typeof d.ns === 'string' && NAMESPACES.indexOf(d.ns) >= 0) return d;
              }
              return null;
            } catch (err) {
              warn(err);
              return null;
            }
          }

          /** 从 descriptor.value 里读 memoryDir，兼容 live 引用。 */
          function dirOf(descriptor) {
            if (!descriptor) return '';
            var v = descriptor.value;
            if (v === undefined || v === null) return '';
            var raw = v.memoryDir;
            if (raw !== undefined && raw !== null && typeof raw.get === 'function') {
              try { raw = raw.get(); } catch (e) { raw = undefined; }
            }
            return typeof raw === 'string' ? raw : '';
          }

          /** 按候选名逐个试，拿到本插件的 form；解不到返回 null。 */
          function resolveForm(ctx) {
            try {
              var forms = ctx === undefined || ctx === null ? undefined : ctx.configForms;
              if (forms === undefined || forms === null || typeof forms.get !== 'function') return null;
              for (var i = 0; i < NAMESPACES.length; i += 1) {
                var f = forms.get(NAMESPACES[i]);
                if (f !== undefined && f !== null) return f;
              }
              return null;
            } catch (err) {
              warn(err);
              return null;
            }
          }

          /**
           * 订阅设置镜像：投影是异步到达的，订阅本身就是"喊它读一次"。
           * 返回稳定的字符串快照，只在命名空间集合变化时触发重渲染。
           */
          function useServedNamespaces(ctx) {
            var forms = ctx === undefined || ctx === null ? undefined : ctx.configForms;
            var mirror = forms === undefined || forms === null ? undefined : forms.mirror;
            return useSync(
              function (listener) {
                if (mirror === undefined || mirror === null || typeof mirror.subscribe !== 'function') {
                  return function () {};
                }
                var off = mirror.subscribe(listener);
                if (typeof mirror.ensure === 'function') mirror.ensure();
                return typeof off === 'function' ? off : function () {};
              },
              function () {
                try {
                  if (mirror === undefined || mirror === null || typeof mirror.getSnapshot !== 'function') return '';
                  var snap = mirror.getSnapshot();
                  var view = snap === undefined || snap === null ? undefined : snap.view;
                  var list = view === undefined || view === null || !Array.isArray(view.namespaces) ? [] : view.namespaces;
                  var names = [];
                  for (var i = 0; i < list.length; i += 1) {
                    var ns = list[i] === undefined || list[i] === null ? undefined : list[i].ns;
                    if (typeof ns === 'string' && ns.length > 0) names.push(ns);
                  }
                  return names.join('|');
                } catch (err) {
                  warn(err);
                  return '';
                }
              },
            );
          }

          /**
           * 把 draft 变成 form 操作。
           * 只关心一个字段，逻辑比通用版简单得多。
           */
          function buildOperations(currentValue, draftValue) {
            var current = String(currentValue === undefined || currentValue === null ? '' : currentValue);
            var next = String(draftValue === undefined || draftValue === null ? '' : draftValue).trim();
            if (next === current) return [];
            if (next === '') return [{ op: 'unset', path: ['memoryDir'] }];
            return [{ op: 'set', path: ['memoryDir'], value: next }];
          }

          /** 设置页本体。 */
          function SettingsPage(props) {
            var ctx = props.ctx;
            // 投影是异步到达的：订阅一次，名字集合变了就重渲染；
            // 每次都重新解析 form，别缓存 —— 挂载时它可能还不存在。
            var servedNames = useServedNamespaces(ctx);

            // forms.get() 可能每次返回新实例；固定住第一次拿到的那个，
            // 否则 useSync 的 subscribe 和 getSnapshot 会指向不同对象，
            // 订阅收到的更新传不到快照上。
            // 只固定「完整」的 form（有 getSnapshot/mutate 的那种）。
            // 过早拿到空壳对象会让后续一直用空壳 —— 实测 form 只有 unsubscribe。
            var formRef = React.useRef(null);
            if (formRef.current === null || typeof formRef.current.getSnapshot !== 'function') {
              var first = resolveForm(ctx);
              if (first !== null && first !== undefined && typeof first.getSnapshot === 'function') {
                formRef.current = first;
              }
            }
            var form = formRef.current;

            // form 不可用时退回读 mirror：那里有 value 和 revision，至少能显示现状。
            var descriptor = readDescriptor(ctx);
            var mirrorDir = dirOf(descriptor);
            var mirrorRevision = descriptor === null || descriptor === undefined ? undefined : descriptor.revision;

            var state = useSync(
              function (listener) {
                return form && typeof form.subscribe === 'function' ? form.subscribe(listener) : function () {};
              },
              function () {
                return form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : emptySnapshot();
              },
            );

            var currentRaw = state && state.value !== undefined && state.value !== null ? state.value.memoryDir : undefined;
            if (currentRaw !== undefined && currentRaw !== null && typeof currentRaw.get === 'function') {
              try { currentRaw = currentRaw.get(); } catch (e) { currentRaw = undefined; }
            }
            var formDir = String(currentRaw === undefined || currentRaw === null ? '' : currentRaw);
            var current = formDir !== '' ? formDir : mirrorDir;
            // revision 同理：form 里可能是 undefined，mirror 里有。
            var revision = state !== undefined && typeof state.revision === 'number' ? state.revision : mirrorRevision;

            var draftPair = React.useState(null);
            var draft = draftPair[0];
            var setDraft = draftPair[1];
            var phasePair = React.useState('idle');
            var phase = phasePair[0];
            var setPhase = phasePair[1];
            var errPair = React.useState('');
            var error = errPair[0];
            var setError = errPair[1];

            var value = draft === null ? current : draft;
            // 只要 form 拿到、mutate 可用、且不是明确只读，就允许编辑。
            // 不苛求 status === 'ready' —— 那只是「投影已完成」的标志，
            // 而 form 本身能拿到就已经说明投影成功了。
            // 快照还没数据时主动催一次：mirror.ensure() 是「喊 Host 推一份过来」，
            // 投影是异步的，挂载那一刻可能还没到。最多试 10 次（约 2 秒）。
            var triesRef = React.useRef(0);
            React.useEffect(function () {
              if (!form || state.status === 'ready') return undefined;
              if (triesRef.current >= 10) return undefined;
              var forms = ctx.configForms;
              if (!forms || !forms.mirror || typeof forms.mirror.ensure !== 'function') return undefined;
              var timer = window.setTimeout(function () {
                triesRef.current += 1;
                try { forms.mirror.ensure(); } catch (e) { /* 忽略 */ }
              }, 200);
              return function () { window.clearTimeout(timer); };
            }, [form, state.status]);

            // 能写要两样：可用的 form（含 mutate）+ 一个 revision。
            var writable = form !== null && form !== undefined && typeof form.mutate === 'function';
            var ready = (writable || descriptor !== null) && state.writable !== false;

            // 保存要带 revision 做乐观锁；没有 revision 说明 Host 还没投影出这份配置，
            // 硬点只会收到「保存被拒绝」。这里提前禁用，把失败变成诚实的只读提示。
            var canSave = writable && typeof revision === 'number';

            function save() {
              if (!ready || phase === 'saving') return;
              var ops = buildOperations(current, value);
              if (ops.length === 0) { setDraft(null); setPhase('saved'); return; }
              setPhase('saving');
              setError('');
              Promise.resolve(form.mutate(ops, revision)).then(
                function (accepted) {
                  if (accepted === false) { setPhase('failed'); setError('保存被拒绝（配置可能已被别处改动，刷新后再试）'); return; }
                  setDraft(null);
                  setPhase('saved');
                },
                function (err) {
                  warn(err);
                  setPhase('failed');
                  setError(err instanceof Error ? err.message : String(err));
                },
              );
            }

            function reset() {
              setDraft(null);
              setPhase('idle');
              setError('');
            }

            var lbl = { display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--dsw-alias-label-secondary)' };
            var hint = { margin: '6px 0 0', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' };
            var inputStyle = {
              width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: '13px',
              fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)',
              background: 'var(--dsw-alias-bg-primary)', border: '1px solid var(--dsw-alias-line-secondary)',
              borderRadius: '6px', outline: 'none',
            };
            var btn = function (primary) {
              return {
                padding: '6px 14px', fontSize: '13px', fontFamily: 'inherit', cursor: ready ? 'pointer' : 'not-allowed',
                borderRadius: '6px', opacity: ready ? 1 : 0.5,
                border: primary ? 'none' : '1px solid var(--dsw-alias-line-secondary)',
                background: primary ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'transparent',
                color: primary ? '#fff' : 'var(--dsw-alias-label-primary)',
              };
            };

            var children = [
              h('h3', { key: 'title', style: { margin: 0, fontSize: '16px', lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' } }, '记忆曲线'),
              h('p', { key: 'desc', style: { margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' } },
                '按遗忘曲线给历史事件分级：高留存的进上下文，低留存的只留文件。这里只配一件事——完整记忆存到哪儿。'),
            ];

            if (!hasFormService(ctx)) {
              children.push(h('p', { key: 'na', style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-state-warn-primary)' } },
                '当前部署没有提供 configForms 服务，无法在这里改配置。可以直接编辑 profile 的 cordis.patch.yml。'));
              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0' } }, children);
            }

            if (form === null || form === undefined) {
              children.push(h('p', { key: 'wait', style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } },
                '正在等待宿主提供配置…（若一直停在这里，说明本插件的配置没被投影出来）'));
              children.push(h('p', { key: 'ns', style: { margin: 0, fontSize: '11px', fontFamily: 'ui-monospace, monospace', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' } },
                '尝试的命名空间：' + NAMESPACES.join(' / ')));
              children.push(h('p', { key: 'served', style: { margin: 0, fontSize: '11px', fontFamily: 'ui-monospace, monospace', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' } },
                '宿主已提供：' + (servedNames === '' ? '（空）' : servedNames)));
              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' } }, children);
            }

            if (form === null || typeof form.mutate !== 'function') {
              // 只能读、不能写：form 对象没接上（宿主 client bundle 的问题）。
              // 与其给一个点了就报错的按钮，不如老老实实显示现状 + 怎么改。
              children.push(
                h('div', { key: 'readonly', style: { marginTop: '4px' } },
                  h('label', { style: lbl }, '完整记忆存放目录'),
                  h('div', {
                    style: {
                      padding: '8px 10px', fontSize: '13px', fontFamily: 'ui-monospace, monospace',
                      color: 'var(--dsw-alias-label-primary)',
                      background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.08))',
                      border: '1px solid var(--dsw-alias-line-secondary)', borderRadius: '6px',
                    },
                  }, current === '' ? '（未配置，走在回退链上）' : current),
                  h('p', { style: hint },
                    '要改路径，编辑 profile 的 cordis.patch.yml，给 memory-curve 那条加一行：'),
                  h('p', {
                    style: {
                      margin: '4px 0 0', fontSize: '12px', fontFamily: 'ui-monospace, monospace',
                      color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre',
                    },
                  }, 'memoryDir: D:\\memory'),
                  h('p', { style: hint },
                    '或者设环境变量 DSH_MEMORY_DIR。两者都比这里可靠。'),
                ),
              );
              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0' } }, children);
            }

            children.push(
              h('div', { key: 'field', style: { marginTop: '4px' } },
                h('label', { style: lbl, htmlFor: 'memory-curve-dir' }, '完整记忆存放目录'),
                h('input', {
                  id: 'memory-curve-dir',
                  type: 'text',
                  value: value,
                  placeholder: '例如 D:\\memory　留空则用 <DSH_HOME>\\memory',
                  disabled: !canSave,
                  spellCheck: false,
                  style: inputStyle,
                  onChange: function (e) { setDraft(e.target.value); setPhase('idle'); setError(''); },
                }),
                h('p', { style: hint },
                  '填了就用它，目录不存在会自动创建。支持 %USERPROFILE%\\memory、~/memory、D:/memory 这些写法。'),
                h('p', { style: hint },
                  '留空则依次回退到 DSH_MEMORY_DIR 环境变量、D:\\memory（存在才用）、<DSH_HOME>\\memory。'),
              ),
            );

            if (ready && !canSave) {
              children.push(h('p', { key: 'notproj', style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
                '配置投影未就绪（缺少 revision），暂不可保存。重启 DSH 后重试。'));
            }

            if (error !== '') {
              children.push(h('p', { key: 'err', style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' } }, error));
            } else if (phase === 'saved') {
              children.push(h('p', { key: 'ok', style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' } }, '已保存。下一轮对话就会用新目录。'));
            }

            var dirty = draft !== null && draft !== current;
            children.push(
              h('div', { key: 'actions', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' } },
                h('button', { type: 'button', style: btn(true), disabled: !canSave || !dirty || phase === 'saving', onClick: save },
                  phase === 'saving' ? '保存中…' : '保存'),
                h('button', { type: 'button', style: btn(false), disabled: !dirty || phase === 'saving', onClick: reset }, '撤销'),
              ),
            );

            children.push(
              h('p', { key: 'path', style: hint },
                '当前生效：' + (current === '' ? '（未配置，走在回退链上）' : current)),
            );
            children.push(
              h('p', { key: 'dbg', style: { margin: 0, fontSize: '11px', fontFamily: 'ui-monospace, monospace', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' } },
                'status=' + String(state.status)
                + '　rev=' + String(state.revision)
                + '　writable=' + String(state.writable)
                + '　form=' + (form === null || form === undefined ? 'null' : 'ok')
                + '　候选=' + (function () {
                    try {
                      var forms = ctx.configForms;
                      if (!forms || typeof forms.get !== 'function') return 'no-service';
                      var hit = [];
                      for (var i = 0; i < NAMESPACES.length; i += 1) {
                        var f2 = forms.get(NAMESPACES[i]);
                        hit.push(NAMESPACES[i] + ':' + (f2 ? 'Y' : 'N'));
                      }
                      return hit.join(' ');
                    } catch (e) { return 'err'; }
                  })()
                + '　已提供=' + (servedNames === '' ? '(空)' : servedNames)
                + '　form方法=' + (function () {
                    if (!form) return '-';
                    try {
                      var ks = [];
                      for (var k in form) { if (typeof form[k] === 'function') ks.push(k); }
                      return ks.join(',') || '(无函数)';
                    } catch (e) { return 'err'; }
                  })()
                + '　快照=' + (function () {
                    try {
                      if (!form || typeof form.getSnapshot !== 'function') return '无';
                      var s = form.getSnapshot();
                      return 'status=' + String(s?.status) + ',rev=' + String(s?.revision) + ',hasValue=' + (s?.value !== undefined);
                    } catch (e) { return 'err:' + e.message; }
                  })()
                + '　mirror=' + (function () {
                    try {
                      var forms = ctx.configForms;
                      var m = forms && forms.mirror;
                      if (!m || typeof m.getSnapshot !== 'function') return '无mirror';
                      var snap = m.getSnapshot();
                      var list = snap?.view?.namespaces;
                      if (!Array.isArray(list)) return 'view空';
                      var hit = null;
                      for (var i = 0; i < list.length; i++) {
                        if (list[i] && (list[i].ns === 'memory-curve' || list[i].ns === 'include:memory-curve')) { hit = list[i]; break; }
                      }
                      if (!hit) return '未找到(' + list.length + '条)';
                      return 'ns=' + hit.ns + ' keys=' + Object.keys(hit).join(',');
                    } catch (e) { return 'err:' + e.message; }
                  })()),
            );

            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0' } }, children);
          }

          /**
           * 当前页面的注销函数。
           *
           * 必须放在模块作用域：mountPage 会被调用两次（apply 一次，
           * whileServed 回调再一次），如果 live 是函数内变量，两次都看到 null，
           * 就会向同一个槽位注册两遍 —— 报 "already has an entry with id"。
           */
          var liveMount = null;

          /** 把一个页面注册进 settings.section，返回注销函数。 */
          function mountPage(ctx) {
            try {
              ctx.slots.inject(SLOT, function () {
                if (liveMount !== null) return liveMount;
                var dispose;
                try {
                  dispose = ctx.slots.register({
                    name: SLOT,
                    id: ENTRY,
                    order: 60,
                    label: function () { return '记忆曲线'; },
                  }, function (props) {
                    return h(SettingsPage, Object.assign({}, props, { ctx: ctx }));
                  });
                } catch (err) {
                  warn(err);
                  return function () {};
                }
                if (typeof dispose !== 'function') return function () {};
                liveMount = function () {
                  try { dispose(); } catch (err) { warn(err); } finally { liveMount = null; }
                };
                return liveMount;
              });
            } catch (err) {
              warn(err);
            }
          }

          /** 插件入口。 */
          function apply(ctx) {
            try {
              mountPage(ctx);

              // 配置投影是异步到达的；服务提供 whileServed 时再挂一次（重复挂是无害的）。
              try {
                var forms = ctx.configForms;
                if (forms && typeof forms.whileServed === 'function') {
                  forms.whileServed([ENTRY, 'include:' + ENTRY], function () {
                    mountPage(ctx);
                    return function () {};
                  });
                }
              } catch (err) {
                warn(err);
              }
            } catch (err) {
              warn(err);
            }
          }

          // configForms / slots 必须声明：Cordis 只在模块主动要求时才暴露服务。
          return { inject: ['slots', 'configForms'], apply: apply };
        } catch (error) {
          warn(error);
          return { inject: ['slots', 'configForms'], apply: function () {} };
        }
      },
    });
  } catch (error) {
    warn(error);
  }
})();
