import React, { useEffect, useRef, useState } from 'react';
import { Button, Dropdown, message, Modal, theme, Typography } from 'antd';
import { BulbOutlined, CheckOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { decisionTemplates } from '../assets/decision-templates';
import { displayError } from '../helpers/error-message.ts';
import { DecisionContent, DecisionEdge, DecisionNode } from '../helpers/graph.ts';
import { useSearchParams } from 'react-router-dom';
import { DecisionGraph, DecisionGraphRef } from '@gorules/jdm-editor';
import { PageHeader } from '../components/page-header.tsx';
import { DirectedGraph } from 'graphology';
import { hasCycle } from 'graphology-dag';
import { Stack } from '../components/stack.tsx';
import { match, P } from 'ts-pattern';

import classes from './decision-simple.module.css';
import { ThemePreference, useTheme } from '../context/theme.provider.tsx';
import axios from 'axios';

enum DocumentFileTypes {
  Decision = 'application/vnd.gorules.decision',
}

const supportFSApi = Object.hasOwn(window, 'showSaveFilePicker');

export const DecisionSimplePage: React.FC = () => {
  const { token } = theme.useToken();
  const fileInput = useRef<HTMLInputElement>(null);
  const graphRef = React.useRef<DecisionGraphRef>(null);
  const { themePreference, setThemePreference } = useTheme();

  const [searchParams] = useSearchParams();
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle>();
  const [simulatorOpened, setSimulatorOpened] = useState(false);
  const [graph, setGraph] = useState<DecisionContent>({ nodes: [], edges: [] });
  const [fileName, setFileName] = useState('Name');

  useEffect(() => {
    const templateParam = searchParams.get('template');
    if (templateParam) {
      loadTemplateGraph(templateParam);
    }
  }, []);

  const loadTemplateGraph = (template: string) => {
    const templateGraph = match(template)
      .with(P.string, (template) => decisionTemplates?.[template])
      .otherwise(() => undefined);

    if (templateGraph) {
      setGraph(templateGraph);
    }
  };

  const openFile = async () => {
    if (!supportFSApi) {
      fileInput.current?.click?.();
      return;
    }

    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ accept: { 'application/json': ['.json'] } }],
      });

      setFileHandle(handle);

      const file = await handle.getFile();
      const content = await file.text();
      setFileName(file?.name);
      const parsed = JSON.parse(content);
      setGraph({
        nodes: parsed?.nodes || [],
        edges: parsed?.edges || [],
      });
    } catch (err) {
      displayError(err);
    }
  };

  const saveFileAs = async () => {
    if (!supportFSApi) {
      return await handleDownload();
    }

    let writable: FileSystemWritableFileStream | undefined = undefined;
    try {
      checkCyclic();
      const json = JSON.stringify({ contentType: DocumentFileTypes.Decision, ...graph }, null, 2);
      const newFileName = `${fileName.replaceAll('.json', '')}.json`;
      const handle = await window.showSaveFilePicker({
        types: [{ description: newFileName, accept: { 'application/json': ['.json'] } }],
      });

      writable = await handle.createWritable();
      await writable.write(json);
      setFileHandle(handle);
      const file = await handle.getFile();
      setFileName(file.name);
      message.success('File saved');
    } catch (e) {
      displayError(e);
    } finally {
      writable?.close?.();
    }
  };

  const saveFile = async () => {
    if (!supportFSApi) {
      message.error('Unsupported file system API');
      return;
    }

    if (fileHandle) {
      let writable: FileSystemWritableFileStream | undefined = undefined;
      try {
        writable = await fileHandle.createWritable();
        checkCyclic();

        const json = JSON.stringify({ contentType: DocumentFileTypes.Decision, ...graph }, null, 2);
        await writable.write(json);
        message.success('File saved');
      } catch (e) {
        displayError(e);
      } finally {
        writable?.close?.();
      }
    }
  };

  const handleNew = async () => {
    Modal.confirm({
      title: 'New decision',
      icon: false,
      content: <div>Are you sure you want to create new blank decision, your current work might be lost?</div>,
      onOk: async () => {
        setGraph({
          nodes: [],
          edges: [],
        });
      },
    });
  };

  const handleOpenMenu = async (e: { key: string }) => {
    if (e.key === 'file-system') {
      openFile();
      return;
    }

    if (Object.hasOwn(decisionTemplates, e.key)) {
      Modal.confirm({
        title: 'Open example',
        icon: false,
        content: <div>Are you sure you want to open example decision, your current work might be lost?</div>,
        onOk: async () => loadTemplateGraph(e.key),
      });
    }
  };

  const checkCyclic = (dc: DecisionContent | undefined = undefined) => {
    const decisionContent = match(dc)
      .with(P.nullish, () => graph)
      .otherwise((data) => data);

    const diGraph = new DirectedGraph();
    (decisionContent?.edges || []).forEach((edge) => {
      diGraph.mergeEdge(edge.sourceId, edge.targetId);
    });

    if (hasCycle(diGraph)) {
      throw new Error('Circular dependencies detected');
    }
  };

  const handleDownload = async () => {
    try {
      checkCyclic();
      // create file in browser
      const newFileName = `${fileName.replaceAll('.json', '')}.json`;
      const json = JSON.stringify({ contentType: DocumentFileTypes.Decision, ...graph }, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const href = URL.createObjectURL(blob);

      // create "a" HTLM element with href to file
      const link = window.document.createElement('a');
      link.href = href;
      link.download = newFileName;
      window.document.body.appendChild(link);
      link.click();

      // clean up "a" element & remove ObjectURL
      window.document.body.removeChild(link);
      URL.revokeObjectURL(href);
    } catch (e) {
      displayError(e);
    }
  };

  const handleUploadInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event?.target?.files as FileList;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e?.target?.result as string);
        if (parsed?.contentType !== DocumentFileTypes.Decision) {
          throw new Error('Invalid content type');
        }

        const nodes: DecisionNode[] = parsed.nodes || [];
        const nodeIds = nodes.map((node) => node.id);
        const edges: DecisionEdge[] = ((parsed.edges || []) as DecisionEdge[]).filter(
          (edge) => nodeIds.includes(edge?.targetId) && nodeIds.includes(edge?.sourceId),
        );

        checkCyclic({ edges, nodes });
        setGraph({ edges, nodes });
        setFileName(fileList?.[0]?.name);
      } catch (e) {
        displayError(e);
      }
    };

    reader.readAsText(Array.from(fileList)?.[0], 'UTF-8');
  };

  return (
    <>
      <input
        hidden
        accept="application/json"
        type="file"
        ref={fileInput}
        onChange={handleUploadInput}
        onClick={(event) => {
          if ('value' in event.target) {
            event.target.value = null;
          }
        }}
      />

      <div className={classes.page}>
        <PageHeader
          style={{
            padding: '8px 16px',
            background: token.colorBgLayout,
            boxSizing: 'border-box',
            borderBottom: `1px solid ${token.colorBorder}`,
          }}
          title={
            <div className={classes.heading}>
              <div className={classes.logo}>
                <img height={48} width={48} src={'/favicon.svg'} />
              </div>
              <div className={classes.headingContent}>
                <Typography.Title
                  level={4}
                  style={{ margin: 0 }}
                  className={classes.headingTitle}
                  editable={{
                    onChange: (value) => setFileName(value.trim()),
                    text: fileName,
                    maxLength: 24,
                    autoSize: { maxRows: 1 },
                  }}
                >
                  {fileName}
                </Typography.Title>
                <Stack horizontal verticalAlign="center" gap={8}>
                  <Button onClick={handleNew} type={'text'} size={'small'}>
                    New
                  </Button>
                  <Dropdown
                    menu={{
                      onClick: handleOpenMenu,
                      items: [
                        {
                          label: 'File system',
                          key: 'file-system',
                        },
                        {
                          type: 'divider',
                        },
                        {
                          label: 'Fintech: Company analysis',
                          key: 'company-analysis',
                        },
                        {
                          label: 'Fintech: AML',
                          key: 'aml',
                        },
                        {
                          label: 'Retail: Shipping fees',
                          key: 'shipping-fees',
                        },
                      ],
                    }}
                  >
                    <Button type={'text'} size={'small'}>
                      Open
                    </Button>
                  </Dropdown>
                  {supportFSApi && (
                    <Button onClick={saveFile} type={'text'} size={'small'}>
                      Save
                    </Button>
                  )}
                  <Button onClick={saveFileAs} type={'text'} size={'small'}>
                    Save as
                  </Button>
                </Stack>
              </div>
            </div>
          }
          ghost={false}
          extra={[
            <Button
              key="extra"
              type={simulatorOpened ? 'primary' : 'default'}
              ghost={simulatorOpened}
              icon={<PlayCircleOutlined />}
              onClick={() => graphRef.current?.toggleSimulator()}
            >
              {simulatorOpened ? 'Close' : 'Open'} Simulator
            </Button>,
            <Dropdown
              key="theme-menu"
              overlayStyle={{ minWidth: 150 }}
              menu={{
                onClick: ({ key }) => setThemePreference(key as ThemePreference),
                items: [
                  {
                    label: 'Automatic',
                    key: ThemePreference.Automatic,
                    icon: (
                      <CheckOutlined
                        style={{ visibility: themePreference === ThemePreference.Automatic ? 'visible' : 'hidden' }}
                      />
                    ),
                  },
                  {
                    label: 'Dark',
                    key: ThemePreference.Dark,
                    icon: (
                      <CheckOutlined
                        style={{ visibility: themePreference === ThemePreference.Dark ? 'visible' : 'hidden' }}
                      />
                    ),
                  },
                  {
                    label: 'Light',
                    key: ThemePreference.Light,
                    icon: (
                      <CheckOutlined
                        style={{ visibility: themePreference === ThemePreference.Light ? 'visible' : 'hidden' }}
                      />
                    ),
                  },
                ],
              }}
            >
              <Button type="text" icon={<BulbOutlined />} />
            </Dropdown>,
          ]}
        />
        <div className={classes.contentWrapper}>
          <div className={classes.content}>
            <DecisionGraph
              ref={graphRef}
              value={graph}
              onChange={(value) => setGraph(value)}
              reactFlowProOptions={{ hideAttribution: true }}
              onSimulatorOpen={setSimulatorOpened}
              onSimulationRun={async ({ decisionGraph, context }) => {
                try {
                  const { data } = await axios.post('/api/simulate', {
                    context,
                    content: decisionGraph,
                  });

                  return { result: data };
                } catch (e) {
                  if (axios.isAxiosError(e)) {
                    return {
                      error: {
                        message: e.response?.data?.source,
                        data: e.response?.data,
                      },
                    };
                  }

                  return { error: { message: 'Simulation failed' } };
                }
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
};
