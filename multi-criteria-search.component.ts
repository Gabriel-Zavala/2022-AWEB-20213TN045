import { Component, OnDestroy, OnInit } from '@angular/core';
import { MatTableDataSource } from '@angular/material/table';
import {
  FormGroupValue,
  RequestFormSearch,
  ResponseDataSearch,
  SearchResult,
} from '../../../interfaces/inventory-management/multi-criteria-search.interface';
import { ResourcesService } from '../../../services/resources.service';
import { InventoryManagementService } from '../../../services/inventory-management/inventory-management.service';
import { MatDialog } from '@angular/material/dialog';
import { FormSearchComponent } from './form-search/form-search.component';
import { lastValueFrom, Subscription } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { EncService } from '../../../services/enc.service';
import { FunctionsService } from '../../../services/functions.service';
import { UsersProfilesService } from '../../../services/users-profiles.service';
import { SocketService } from '../../../services/socket.service';
import { ProfileInterface } from '../../../interfaces/profile.interface';

@Component({
  selector: 'app-multi-criteria-search',
  templateUrl: './multi-criteria-search.component.html',
  styleUrl: './multi-criteria-search.component.css',
  standalone: false,
})
export class MultiCriteriaSearchComponent implements OnInit, OnDestroy {
  public isLoading: boolean = true;
  public isLoadingForm: boolean = false;
  public dataSource: MatTableDataSource<SearchResult>;
  public arrSearchResult: SearchResult[] = [];
  public formGroupValue: FormGroupValue | null = null;
  public txtSearch: string = '';
  public hasAccess: boolean = false;
  public canShowSearchForm: boolean = false;
  private socketSub: Subscription | undefined;

  public readonly COMPONENT_ID = 'S002V01F02BUMU';
  public readonly ACTION_SEARCH_ID = 'S002V01P01FOBU';

  constructor(
    public resourcesService: ResourcesService,
    private _inventoryManagementService: InventoryManagementService,
    private _dialog: MatDialog,
    private _socketService: SocketService,
    private _usersProfilesService: UsersProfilesService,
    private _functionsService: FunctionsService,
    private _encService: EncService
  ) {
    this.isLoading = false;
    this.isLoadingForm = false;
    this.dataSource = new MatTableDataSource<SearchResult>();
    this.arrSearchResult = [];
    this.formGroupValue = null;
    this.txtSearch = '';
  }

  async ngOnInit() {
    this.isLoading = true;
    try {
      await this.checkInitialPermissions();
    } catch (error) {
      console.error('Error inicializando:', error);
      this.hasAccess = false;
    } finally {
      this.isLoading = false;
      this.setupSocketSubscription();
    }
  }

  ngOnDestroy() {
    if (this.socketSub) this.socketSub.unsubscribe();
  }

  private async checkInitialPermissions() {
    const permissionsEnc = localStorage.getItem('permisos');
    if (!permissionsEnc) {
      this.hasAccess = false;
      return;
    }

    try {
      const permissionsDec = await this._encService.decrypt(permissionsEnc);
      const permObj = JSON.parse(permissionsDec);
      const allPermissions = permObj.permissions || [];

      const targetPerm = this.findPermissionById(
        allPermissions,
        this.COMPONENT_ID
      );
      const searchPerm = this.findPermissionById(
        allPermissions,
        this.ACTION_SEARCH_ID
      );

      this.hasAccess = !!targetPerm && Number(targetPerm.access) > 0;
      this.canShowSearchForm = !!searchPerm && Number(searchPerm.access) > 0;
    } catch (e) {
      console.error('Error desencriptando permisos:', e);
      this.hasAccess = false;
    }
  }

  private setupSocketSubscription() {
    this.socketSub = this._socketService
      .refreshPermissions()
      .subscribe(async (profUpdEnc) => {
        try {
          const idUser = localStorage.getItem('idusuario');
          const currentProfileEnc = localStorage.getItem('perfil');

          if (!idUser || !currentProfileEnc) return;

          const currentProfile = await this._encService.decrypt(
            currentProfileEnc
          );
          const profileUpdated = await this._encService.decrypt(`${profUpdEnc}`);

          if (profileUpdated === currentProfile) {
            const profInfo: ProfileInterface = await lastValueFrom(
              this._usersProfilesService.getProfile(currentProfileEnc, idUser, 1)
            );

            const permArr = await this._functionsService.processPermissions(
              profInfo.response.PERMISOS.permissions
            );

            const oldAccess = this.hasAccess;

            const targetPerm = this.findPermissionById(
              permArr,
              this.COMPONENT_ID
            );
            const searchPerm = this.findPermissionById(
              permArr,
              this.ACTION_SEARCH_ID
            );

            this.hasAccess = !!targetPerm && Number(targetPerm.access) > 0;
            this.canShowSearchForm = !!searchPerm && Number(searchPerm.access) > 0;

            if (oldAccess && !this.hasAccess) {
              this._dialog.closeAll();
              this.dataSource.data = [];
              this.resourcesService.openSnackBar('Permisos revocados.');
            } else if (!this.canShowSearchForm) {
              this._dialog.closeAll();
            }
          }
        } catch (e) {
          console.error('Error socket:', e);
        }
      });
  }

  private findPermissionById(permissions: any[], id: string): any {
    if (!permissions || !Array.isArray(permissions)) return null;

    for (const p of permissions) {
      const permId = String(p.id || '').trim().toUpperCase();
      const searchId = String(id || '').trim().toUpperCase();

      if (permId === searchId) {
        return p;
      }

      if (p.children && p.children.length > 0) {
        const found = this.findPermissionById(p.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  public openDialogDetails(
    typeDialog: 'readonly' | 'search',
    searchResult?: SearchResult
  ) {
    if (typeDialog === 'search' && !this.canShowSearchForm) {
      this.resourcesService.openSnackBar(
        'No tiene permisos para realizar busquedas.'
      );
      return;
    }

    let idStockTemp = null;
    if (typeDialog === 'readonly' && searchResult !== undefined) {
      idStockTemp = searchResult.ID_STOCK;
    }

    this._dialog
      .open(FormSearchComponent, {
        disableClose: true,
        width: '1400px',
        maxWidth: '1400px',
        data: {
          typeForm: typeDialog,
          idStock: idStockTemp,
          infoForm: this.formGroupValue,
        },
      })
      .afterClosed()
      .subscribe((result: boolean | any) => {
        if (typeof result !== 'boolean') {
          this.formGroupValue = result;
          this.search(result);
        }
      });
  }

  public async search(objectForm: any) {
    this.isLoading = true;
    this.dataSource.data = [];

    let arrForm = Object.keys(objectForm).map((key) => [key, objectForm[key]]);
    let mapForm = new Map<string, string>();
    let isEmpty: boolean = true;
    arrForm.forEach((form: Array<any>) => {
      if (form[1] !== null && form[0] !== 'FAMILIA' && form[0] !== 'SUBFAMILIA') {
        form[1] = form[1].toString().trim();
        isEmpty = false;
      } else if (form[1] !== null && form[0] === 'FAMILIA') {
        form[1] = form[1]['ID_FAMILIA'];
        isEmpty = false;
      } else if (form[1] !== null && form[0] === 'SUBFAMILIA') {
        form[1] = form[1]['ID_SUBFAMILIA'];
        isEmpty = false;
      }
      mapForm.set(form[0], form[1]);
    });

    if (isEmpty) {
      this.resourcesService.openSnackBar(
        'Debe seleccionar al menos un campo para continuar.'
      );
      return;
    }
    mapForm.set('USUARIO', this.resourcesService.getUser());
    mapForm.set('NUMERO_LINEA', this.resourcesService.getLineNumber().toString());

    const strRequest: string = JSON.stringify(Object.fromEntries(mapForm));
    const jsonRequest: RequestFormSearch = JSON.parse(strRequest);

    await lastValueFrom(this._inventoryManagementService.search(jsonRequest)).then(
      (responseData: ResponseDataSearch) => {
        if (!responseData.error) {
          this.dataSource.data = responseData.response;
          this.arrSearchResult = responseData.response;
        } else {
          this.resourcesService.openSnackBar(`${responseData.msg}`);
        }
      },
      async (httpErrorResponse: HttpErrorResponse) => {
        let response = this.resourcesService.checkErrors(httpErrorResponse);
        if (response !== null && response.reload) {
          await this.search(objectForm);
        }
      }
    );
    this.isLoading = false;
  }

  public applyFilter() {
    const dataValue: string = this.txtSearch.toString().trim().toUpperCase();
    if (dataValue.length > 0) {
      let arrDataValue: SearchResult[] = [];
      this.arrSearchResult.forEach((searchResult: SearchResult) => {
        let exists: boolean = false;

        const arrValues = Object.values(searchResult);
        arrValues.forEach((value: string) => {
          value = value.toString().trim().toUpperCase();
          if (value.includes(dataValue)) {
            exists = true;
          }
        });

        if (exists) {
          arrDataValue.push(searchResult);
        }
      });

      this.dataSource.data = arrDataValue;
    } else {
      this.dataSource.data = this.arrSearchResult;
    }
  }
}
