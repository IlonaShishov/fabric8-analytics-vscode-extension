'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { Config } from './config';
import { getRequestTimeout, getRequestPollInterval, snykURL, defaultDependencyAnalysisReportFilePath } from './constants';
import { multimanifestmodule } from './multimanifestmodule';
import { ProjectDataProvider } from './ProjectDataProvider';
import { stackAnalysisServices } from './stackAnalysisService';
import { StatusMessages } from './statusMessages';
import { DependencyReportPanel } from './dependencyReportPanel';


export module stackanalysismodule {
  export const stackAnalysesLifeCycle = (
    context,
    effectiveF8Var,
    argumentList,
    ecosystem
  ) => {
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: StatusMessages.EXT_TITLE
      },
      p => {
        return new Promise<void>(async (resolve, reject) => {
          p.report({
            message: StatusMessages.WIN_RESOLVING_DEPENDENCIES
          });
          const apiConfig = Config.getApiConfig();

          if (ecosystem === 'maven') {
            await multimanifestmodule.triggerManifestWs(context);
            p.report({
              message: StatusMessages.WIN_ANALYZING_DEPENDENCIES
            });

            const options = {};
            if (apiConfig.crdaSnykToken !== '') {
              options['CRDA_SNYK_TOKEN'] = apiConfig.crdaSnykToken;
            }

            stackAnalysisServices.crdaApiStackAnalysis(argumentList, options)
              .then(resp => {
                p.report({
                  message: StatusMessages.WIN_SUCCESS_ANALYZE_DEPENDENCIES
                });
                let reportFilePath = apiConfig.dependencyAnalysisReportFilePath || defaultDependencyAnalysisReportFilePath;
                let reportDirectoryPath = path.dirname(reportFilePath)
                if (!fs.existsSync(reportDirectoryPath)) {
                  fs.mkdirSync(reportDirectoryPath, { recursive: true });
                }
                fs.writeFile(reportFilePath, resp, (err) => {
                  if (err) {
                    p.report({
                      message: StatusMessages.WIN_FAILURE_ANALYZE_DEPENDENCIES
                    });
                    handleError(err);
                    reject(err);
                  } else {
                    if (DependencyReportPanel.currentPanel) {
                      DependencyReportPanel.currentPanel.doUpdatePanel(resp);
                    }
                    resolve(null);
                  }
                });
              })
              .catch(err => {
                p.report({
                  message: StatusMessages.WIN_FAILURE_RESOLVE_DEPENDENCIES
                });
                handleError(err);
                reject();
              });
          } else {
            ProjectDataProvider[effectiveF8Var](argumentList)
              .then(async dataEpom => {
                await multimanifestmodule.triggerManifestWs(context);
                p.report({
                  message: StatusMessages.WIN_ANALYZING_DEPENDENCIES
                });
                return dataEpom;
              })
              .then(async dataEpom => {
                let formData = await multimanifestmodule.form_manifests_payload(
                  dataEpom, ecosystem
                );
                return formData;
              })
              .then(async formData => {
                let payloadData = formData;
                const options = {};
                let thatContext: any;

                options['uri'] = `${apiConfig.host
                  }/api/v2/stack-analyses?user_key=${apiConfig.apiKey}`;
                options['formData'] = payloadData;
                options['headers'] = {
                  showTransitiveReport: 'true',
                  uuid: process.env.UUID
                };
                thatContext = context;
                let resp = await stackAnalysisServices.postStackAnalysisService(
                  options,
                  thatContext
                );
                p.report({
                  message: StatusMessages.WIN_SUCCESS_ANALYZE_DEPENDENCIES
                });
                return resp;
              })
              .then(async resp => {
                console.log(`Analyzing your stack, id ${resp}`);
                const options = {};
                options['uri'] = `${apiConfig.host
                  }/api/v2/stack-analyses/${resp}?user_key=${apiConfig.apiKey
                  }`;
                options['headers'] = {
                  uuid: process.env.UUID
                };
                let timeoutCounter = getRequestTimeout / getRequestPollInterval;
                const interval = setInterval(() => {
                  stackAnalysisServices
                    .getStackAnalysisService(options)
                    .then(data => {
                      if (!data.hasOwnProperty('error')) {
                        clearInterval(interval);
                        p.report({
                          message: StatusMessages.WIN_FAILURE_ANALYZE_DEPENDENCIES
                        });
                        if (DependencyReportPanel.currentPanel) {
                          DependencyReportPanel.currentPanel.doUpdatePanel(data);
                        }
                        resolve(null);
                      } else {
                        console.log(`Polling for stack report, remaining count:${timeoutCounter}`);
                        --timeoutCounter;
                        if (timeoutCounter <= 0) {
                          let errMsg = `Failed to trigger application's stack analysis, try in a while.`;
                          clearInterval(interval);
                          p.report({
                            message:
                              StatusMessages.WIN_FAILURE_ANALYZE_DEPENDENCIES
                          });
                          handleError(errMsg);
                          reject();
                        }
                      }
                    })
                    .catch(error => {
                      clearInterval(interval);
                      p.report({
                        message: StatusMessages.WIN_FAILURE_ANALYZE_DEPENDENCIES
                      });
                      handleError(error);
                      reject(error);
                    });
                }, getRequestPollInterval);
              })
              .catch(err => {
                p.report({
                  message: StatusMessages.WIN_FAILURE_RESOLVE_DEPENDENCIES
                });
                handleError(err);
                reject();
              });

          }
        });
      }
    );
  };

  export const processStackAnalyses = (
    context,
    workspaceFolder,
    ecosystem,
    uri = null
  ) => {
    let effectiveF8Var: string, argumentList: string;
    if (ecosystem === 'maven') {
      argumentList = uri
        ? uri.fsPath
        : path.join(workspaceFolder.uri.fsPath, 'pom.xml');
      effectiveF8Var = 'effectivef8Pom';
    } else if (ecosystem === 'npm') {
      argumentList = uri
        ? uri.fsPath.split('package.json')[0]
        : workspaceFolder.uri.fsPath;
      effectiveF8Var = 'effectivef8Package';
    } else if (ecosystem === 'pypi') {
      argumentList = uri
        ? uri.fsPath.split('requirements.txt')[0]
        : workspaceFolder.uri.fsPath;
      effectiveF8Var = 'effectivef8Pypi';
    } else if (ecosystem === 'golang') {
      argumentList = uri
        ? uri.fsPath
        : workspaceFolder.uri.fsPath;
      effectiveF8Var = 'effectivef8Golang';
    }
    stackAnalysesLifeCycle(context, effectiveF8Var, argumentList, ecosystem);
  };

  export const handleError = err => {
    if (DependencyReportPanel.currentPanel) {
      DependencyReportPanel.currentPanel.doUpdatePanel('error');
    }
    vscode.window.showErrorMessage(err);
  };

  export const validateSnykToken = async () => {
    const apiConfig = Config.getApiConfig();
    if (apiConfig.crdaSnykToken !== '') {
      const options = {};
      options['uri'] = `${apiConfig.crdaHost}/api/v3/token`;
      options['headers'] = {
        'Crda-Snyk-Token': apiConfig.crdaSnykToken
      };

      stackAnalysisServices.getSnykTokenValidationService(options);

    } else {

      vscode.window.showInformationMessage(`Please note that if you fail to provide a valid Snyk Token in the extension workspace settings, 
                                            Snyk vulnerabilities will not be displayed. 
                                            To resolve this issue, please obtain a valid token from the following link: [here](${snykURL}).`);

    }
  };
}
